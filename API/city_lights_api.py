import io
import json
import math
import os
import re
import struct
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.cookiejar import DefaultCookiePolicy
from pathlib import Path
from threading import Event, Lock, Thread
from urllib.parse import parse_qs, urlparse

import h5py
import requests
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from processing import map_linear, map_logarithmic, normalize_measurements

# Built into a single program with PyInstaller, the cache and the site sit next to the program,
# not in the temporary folder it unpacks itself into.
HERE = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
# The NASA Earthdata token is taken from this environment variable. In a GitHub Codespace the
# repository secret of the same name fills it in. The token is only ever sent to NASA, and is
# never printed or saved.
TOKEN_VARIABLE = "EARTHDATA_TOKEN"
NO_TOKEN = ("The night lights service has no NASA Earthdata token. Set the EARTHDATA_TOKEN environment variable, "
            "or in a Codespace the repository secret of that name, and start the service again.")
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9._~+/=-]+", re.ASCII)
# The cache sits in the project's top folder, one level above this script.
CACHE_DIR = HERE.parent / "city_lights_cache"
CATALOG_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
YEARLY_NIGHT_LIGHTS = "C3860065683-LAADS"
DATASET = "HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/AllAngle_Composite_Snow_Free"
TILE_DEGREES = 10
PIXELS_PER_DEGREE = 240
BLOCK = 32 * 1024
TAIL_BLOCKS = 8
MAX_REQUESTS = 28
MAX_ROUNDS = 12
DEFAULT_LOW_HZ = 220
DEFAULT_HIGH_HZ = 880

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])

lock = Lock()
warm = Event()
warm.set()
file_lists = {}
signed_addresses = {}
answers = {}
http = requests.Session()
http.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=MAX_REQUESTS + 4))
# NASA answers a good token with a login cookie. Keeping it would let later requests in on the
# strength of an earlier request's token, so no cookies are kept and every request stands on its own.
http.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))


class ServiceError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


@app.exception_handler(ServiceError)
def service_error(request, error):
    return JSONResponse({"error": error.message}, status_code=error.status)


@app.exception_handler(requests.RequestException)
def nasa_unreachable(request, error):
    return JSONResponse({"error": "Could not reach NASA's servers. Try again in a moment."}, status_code=502)


def load_token():
    token = os.environ.get(TOKEN_VARIABLE, "").strip()
    if not token:
        raise ServiceError(500, NO_TOKEN)
    if not TOKEN_SHAPE.fullmatch(token):
        raise ServiceError(500, "What is in EARTHDATA_TOKEN does not look like a NASA Earthdata token.")
    return token


# NASA's download link answers with a temporary address on its download network.
# The token is only ever sent to NASA's own link, never to that address.
def signed_address(url, token, session):
    response = session.get(url, headers={"Authorization": f"Bearer {token}"}, allow_redirects=False,
                           stream=True, timeout=60)
    response.close()
    target = response.headers.get("Location", "")
    if response.status_code not in (301, 302, 303, 307, 308) or "urs.earthdata.nasa.gov" in target:
        raise ServiceError(502, "NASA did not accept the Earthdata token. It may have expired.")
    expires = parse_qs(urlparse(target).query).get("Expires", [None])[0]
    return target, float(expires) if expires else time.time() + 300


class SparseFile(io.RawIOBase):
    """Part of a remote file held in memory. Reading a block that has not been downloaded yet
    notes its number in `missing` and fails, so the caller can fetch that block and try again."""

    def __init__(self, size, blocks):
        self.size = size
        self.blocks = blocks
        self.pos = 0
        self.missing = None

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buffer):
        wanted = min(len(buffer), self.size - self.pos)
        done = 0
        while done < wanted:
            number, start = divmod(self.pos + done, BLOCK)
            if number not in self.blocks:
                self.missing = number
                raise OSError("this part of the file has not been downloaded yet")
            piece = self.blocks[number][start:start + wanted - done]
            buffer[done:done + len(piece)] = piece
            done += len(piece)
        self.pos += wanted
        return wanted


# Works out where each compressed block of the brightness layer sits in one yearly file, from the
# parts downloaded so far. Returns that index, or the number of the block it needs next.
def read_index(size, blocks):
    remote = SparseFile(size, blocks)
    try:
        with h5py.File(remote, "r") as file:
            data = file[DATASET]
            if data.dtype.str != "<f4" or data.compression != "gzip" or data.shuffle:
                raise ServiceError(502, "The night lights file is stored in a way this service does not understand.")
            chunks = [data.id.get_chunk_info(number) for number in range(data.id.get_num_chunks())]
            return {
                "chunk_shape": list(data.chunks),
                "fill": float(data.attrs["_FillValue"][0]),
                "chunks": [[*info.chunk_offset, info.byte_offset, info.size] for info in chunks]
            }
    except ServiceError:
        raise
    except Exception:
        if remote.missing is None:
            raise
        return remote.missing


# Downloads some neighbouring blocks of a remote file with one request.
# Returns the size of the whole file and the blocks.
def fetch_blocks(address, first, count):
    start = first * BLOCK
    response = http.get(address, headers={"Range": f"bytes={start}-{start + count * BLOCK - 1}"}, timeout=60)
    if response.status_code != 206:
        raise ServiceError(502, f"NASA's download network answered {response.status_code}.")
    content = response.content
    size = int(response.headers["Content-Range"].split("/")[1])
    return size, [content[i * BLOCK:(i + 1) * BLOCK] for i in range(-(-len(content) // BLOCK))]


# Builds the indexes of several yearly files together. Each round downloads, for every file at the
# same time, the blocks that file needs next, so the waiting is shared between them.
def build_indexes(urls, token):
    with ThreadPoolExecutor(max_workers=min(MAX_REQUESTS, len(urls))) as workers:
        signed = list(workers.map(lambda url: signed_address(url, token, http), urls))
        files = [{"url": url, "signed": pair, "size": None, "blocks": {}, "wanted": (0, 1), "index": None}
                 for url, pair in zip(urls, signed)]
        for round_number in range(MAX_ROUNDS):
            waiting = [file for file in files if file["index"] is None]
            if not waiting:
                break
            fetched = workers.map(lambda file: fetch_blocks(file["signed"][0], *file["wanted"]), waiting)
            for file, (size, blocks) in zip(waiting, fetched):
                file["size"] = size
                for i, block in enumerate(blocks):
                    file["blocks"][file["wanted"][0] + i] = block
            for file in waiting:
                last = (file["size"] - 1) // BLOCK
                if round_number == 0 and last > 0:
                    # The description of the layers is always at the end of the file, so fetch that next.
                    first = max(1, last - TAIL_BLOCKS + 1)
                    file["wanted"] = (first, last - first + 1)
                    continue
                result = read_index(file["size"], file["blocks"])
                if isinstance(result, dict):
                    file["index"] = result
                else:
                    file["wanted"] = (result, min(2, last - result + 1))
    if any(file["index"] is None for file in files):
        raise ServiceError(502, "Could not read the layout of NASA's night lights files.")
    return files


# Asks NASA's public catalog for the yearly files of one 10 degree square, as (year, link) pairs.
def files_for(tile):
    with lock:
        if tile in file_lists:
            return file_lists[tile]
    tile_col, tile_row = tile
    name = f".h{tile_col:02d}v{tile_row:02d}."
    centre = f"{-180 + tile_col * TILE_DEGREES + 5},{90 - tile_row * TILE_DEGREES - 5}"
    response = http.get(CATALOG_URL, params={"collection_concept_id": YEARLY_NIGHT_LIGHTS,
                                             "point": centre, "page_size": 100}, timeout=60)
    response.raise_for_status()
    by_year = {}
    for entry in response.json()["feed"]["entry"]:
        for link in entry["links"]:
            if link["href"].startswith("https://data.") and name in link["href"]:
                by_year[int(entry["time_start"][:4])] = link["href"]
    files = sorted(by_year.items())
    with lock:
        file_lists[tile] = files
    return files


def index_path(url):
    return CACHE_DIR / (url.rsplit("/", 1)[-1] + ".json")


def indexes_for(files, token):
    indexes = {}
    missing = []
    for year, url in files:
        if index_path(url).exists():
            indexes[url] = json.loads(index_path(url).read_text())
        else:
            missing.append(url)
    if missing:
        CACHE_DIR.mkdir(exist_ok=True)
        for file in build_indexes(missing, token):
            with lock:
                signed_addresses[file["url"]] = file["signed"]
            index_path(file["url"]).write_text(json.dumps(file["index"]))
            indexes[file["url"]] = file["index"]
    return indexes


def read_value(url, index, row, col, token):
    rows, cols = index["chunk_shape"]
    first_row, first_col = row // rows * rows, col // cols * cols
    offset, size = next((chunk[2], chunk[3]) for chunk in index["chunks"] if chunk[0] == first_row and chunk[1] == first_col)
    for attempt in range(2):
        with lock:
            address, expires = signed_addresses.get(url, (None, 0))
        if address is None or expires < time.time() + 30:
            address, expires = signed_address(url, token, http)
            with lock:
                signed_addresses[url] = (address, expires)
        response = http.get(address, headers={"Range": f"bytes={offset}-{offset + size - 1}"}, timeout=60)
        if response.status_code == 206:
            break
        with lock:
            signed_addresses.pop(url, None)
    else:
        raise ServiceError(502, f"NASA's download network answered {response.status_code}.")
    block = zlib.decompress(response.content)
    value = struct.unpack_from("<f", block, ((row - first_row) * cols + (col - first_col)) * 4)[0]
    return None if value == index["fill"] or value < 0 or math.isnan(value) else round(value, 2)


def parse_number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return math.nan


# Accepts seconds since the Unix epoch or a date such as "2015-01-01".
def parse_time(text, default):
    if text is None:
        return default
    number = parse_number(text)
    if number > 1e11:
        raise ServiceError(400, "Times given as numbers must be in seconds, not milliseconds.")
    if math.isfinite(number):
        return number
    try:
        moment = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return math.nan
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).timestamp()


# Checks the pitch settings of a request. Returns None when no pitch was asked for.
def pitch_options(pitch, low, high):
    if pitch is None:
        return None
    method = pitch.strip().lower()
    if method not in ("log", "logarithmic", "linear"):
        raise ServiceError(400, "Pitch must be log or linear.")
    low_hz = DEFAULT_LOW_HZ if low is None else parse_number(low)
    high_hz = DEFAULT_HIGH_HZ if high is None else parse_number(high)
    if not math.isfinite(low_hz) or not math.isfinite(high_hz) or low_hz <= 0 or high_hz < low_hz:
        raise ServiceError(400, "The pitch range must be two numbers above zero in hertz, with low not above high.")
    return map_linear if method == "linear" else map_logarithmic, low_hz, high_hz


# Rounds the way JavaScript does, so the numbers match the ocean service exactly.
def rounded(number, decimals):
    return math.floor(number * 10 ** decimals + 0.5) / 10 ** decimals


# Adds normalized (0 to 1) and frequency (hertz) to each measurement, using the project's own
# math in processing.py.
def add_pitch(series, options):
    if options is None or not series:
        return series
    method, low, high = options
    return [{**point, "normalized": rounded(point["normalized"], 4),
             "frequency": rounded(method(point["normalized"], low, high), 2)}
            for point in normalize_measurements(series)]


# Yearly night-time brightness at one point, in nanowatts per square centimetre per steradian,
# from NASA's Black Marble yearly product (VNP46A4), one value per year from 2012 on.
@app.get("/api/city-lights/brightness")
def brightness(lat: str | None = None, lon: str | None = None, start: str | None = None, end: str | None = None,
               pitch: str | None = None, low: str | None = None, high: str | None = None):
    pitch_settings = pitch_options(pitch, low, high)
    latitude, longitude = parse_number(lat), parse_number(lon)
    first, last = parse_time(start, -math.inf), parse_time(end, math.inf)
    if math.isnan(first) or math.isnan(last) or last < first:
        raise ServiceError(400, "Start and end times must be valid, with the end not before the start.")
    if not math.isfinite(latitude) or not math.isfinite(longitude) or not -90 <= latitude <= 90:
        raise ServiceError(400, "Latitude must be between -90 and 90 and longitude must be a number.")

    longitude = (longitude + 180) % 360 - 180
    tile_col = min(35, int((longitude + 180) // TILE_DEGREES))
    tile_row = min(17, int((90 - latitude) // TILE_DEGREES))
    size = TILE_DEGREES * PIXELS_PER_DEGREE
    row = min(size - 1, int((90 - tile_row * TILE_DEGREES - latitude) * PIXELS_PER_DEGREE))
    col = min(size - 1, int((longitude + 180 - tile_col * TILE_DEGREES) * PIXELS_PER_DEGREE))
    key = (tile_col, tile_row, row, col)

    with lock:
        series = answers.get(key)
    if series is None:
        token = load_token()
        files = files_for((tile_col, tile_row))
        indexes = indexes_for(files, token)
        with ThreadPoolExecutor(max_workers=max(1, len(files))) as readers:
            values = list(readers.map(lambda item: read_value(item[1], indexes[item[1]], row, col, token), files))
        series = []
        for (year, url), value in zip(files, values):
            if value is not None:
                series.append({"timestamp": int(datetime(year, 1, 1, tzinfo=timezone.utc).timestamp()),
                               "date": f"{year}-01-01", "year": year, "value": value})
        with lock:
            answers[key] = series
    return add_pitch([point for point in series if first <= point["timestamp"] <= last], pitch_settings)


# The first requests to NASA after a quiet spell are slow, so the service makes some while it
# starts instead of leaving that wait to the first lookup.
def warm_up():
    try:
        token = load_token()

        def touch(item):
            address = signed_address(item[1], token, http)
            fetch_blocks(address[0], 0, 1)
            with lock:
                signed_addresses[item[1]] = address

        files = files_for((21, 5))
        with ThreadPoolExecutor(max_workers=len(files)) as workers:
            list(workers.map(touch, files))
        print("Ready.", flush=True)
    except Exception:
        print("Could not reach NASA while starting. Lookups will try again when asked.", flush=True)
    finally:
        warm.set()


@app.get("/api/city-lights/ready")
def ready():
    return JSONResponse({"ready": warm.is_set()}, status_code=200 if warm.is_set() else 503)


@app.exception_handler(404)
def unknown_address(request, error):
    return JSONResponse({"error": "Unknown API address."}, status_code=404)


if __name__ == "__main__":
    port = 8001
    for argument in sys.argv[1:]:
        if not argument.isdigit():
            raise SystemExit("The only thing to give when starting is a port number. "
                             "The NASA token is read from the EARTHDATA_TOKEN environment variable.")
        port = int(argument)
    print(f"The night lights service is running at http://127.0.0.1:{port}")
    try:
        load_token()
    except ServiceError as error:
        print(error.message + " Until then every lookup is refused.")
    else:
        print("Opening connections to NASA, which takes up to half a minute.")
        warm.clear()
        Thread(target=warm_up, daemon=True).start()
    print("Press Ctrl+C to stop.", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
