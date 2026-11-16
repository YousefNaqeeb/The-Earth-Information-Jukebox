import io
import json
import math
import os
import re
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.cookiejar import DefaultCookiePolicy
from pathlib import Path
from threading import Event, Lock, Thread

import h5py
import numpy
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
NO_TOKEN = ("The lightning service has no NASA Earthdata token. Set the EARTHDATA_TOKEN environment variable, "
            "or in a Codespace the repository secret of that name, and start the service again.")
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9._~+/=-]+", re.ASCII)
# The cache sits in the project's top folder, one level above this script.
CACHE_DIR = HERE.parent / "lightning_cache"
CATALOG_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
SPACE_STATION_LIGHTNING = "C3838944284-GHRC_DAAC"
# The only addresses the token is ever sent to, and the only names a cache file can take: this
# dataset's files on NASA's own download hosts. Links are checked because they are kept on disk.
ORBIT_FILE = re.compile(r"https://[\w.-]+\.(?:earthdata|earthdatacloud)\.nasa\.gov/[\w./-]+/(ISS_LIS_[\w.]+\.nc)", re.ASCII)
FLASH_TIME = "lightning_flash_TAI93_time"
FLASH_LATITUDE = "lightning_flash_lat"
FLASH_LONGITUDE = "lightning_flash_lon"
TIME_UNITS = b"seconds since 1993-01-01 00:00:00.000"
# The files count seconds from the start of 1993 without skipping leap seconds. Ten of those fell
# between then and the first file, and none since.
TAI93_TO_UNIX = 725846400 - 10
FLASH = numpy.dtype([("time", "<u4"), ("lat", "<f4"), ("lon", "<f4")])
DAY = 86400
FIRST_DAY = int(datetime(2017, 3, 1, tzinfo=timezone.utc).timestamp()) // DAY
LAST_DAY = int(datetime(2023, 11, 16, tzinfo=timezone.utc).timestamp()) // DAY
# The catalog's times run about ten seconds late, so files are matched to days with some slack.
CATALOG_SLACK = 60
# A day that is not cached yet takes about 2 seconds and 2.3 megabytes, so a month is about a minute.
MAX_DAYS = 31
DEFAULT_RADIUS = 100
EARTH_RADIUS = 6371.0088
BLOCK = 4 * 1024
# Where the flash lists and the directions to them sit in most files, as (first block, count).
USUAL_BLOCKS = (90, 30)
MAX_REQUESTS = 28
MAX_ROUNDS = 12
DEFAULT_LOW_HZ = 220
DEFAULT_HIGH_HZ = 880

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])

# Held by the one lookup that is adding to the cache. Lookups that are fully cached never wait for it.
writing = Lock()
warm = Event()
warm.set()
certificates = ssl.create_default_context(cafile=requests.certs.where())


# requests reads its whole list of trusted certificates again for every connection it opens, a
# quarter of a second each time, one after another. Sharing one prepared list makes opening many
# connections at once quick. Certificates are still checked.
class SharedCertificates(requests.adapters.HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, ssl_context=certificates, **kwargs)

    def cert_verify(self, conn, url, verify, cert):
        conn.cert_reqs = "CERT_REQUIRED"


http = requests.Session()
http.mount("https://", SharedCertificates(pool_maxsize=MAX_REQUESTS + 4))
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
    token = (
        os.environ.get(TOKEN_VARIABLE, "").strip()
        or os.environ.get("NASA_EARTHDATA_TOKEN", "").strip()
    )

    if not token:
        raise ServiceError(500, NO_TOKEN)

    if not TOKEN_SHAPE.fullmatch(token):
        raise ServiceError(500, "What is in EARTHDATA_TOKEN does not look like a NASA Earthdata token.")

    return token


def orbit_name(url):
    match = ORBIT_FILE.fullmatch(url)
    if not match:
        raise ServiceError(500, "The lightning cache lists a file that is not on NASA's download site.")
    return match[1]


# NASA's download link answers with a temporary address on its download network.
# The token is only ever sent to NASA's own link, never to that address.
def signed_address(url, token):
    orbit_name(url)
    response = http.get(url, headers={"Authorization": f"Bearer {token}"}, allow_redirects=False,
                        stream=True, timeout=60)
    response.close()
    target = response.headers.get("Location", "")
    if response.status_code not in (301, 302, 303, 307, 308) or "urs.earthdata.nasa.gov" in target:
        raise ServiceError(502, "NASA did not accept the Earthdata token. It may have expired.")
    return target


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


# Reads the time and place of every flash in one orbit file from the parts downloaded so far.
# Returns the flashes, or the number of the block it needs next.
def read_flashes(size, blocks):
    remote = SparseFile(size, blocks)
    flashes = numpy.empty(0, FLASH)
    try:
        with h5py.File(remote, "r") as file:
            # An orbit that saw no lightning has no flash lists at all.
            if FLASH_TIME in file:
                times = file[FLASH_TIME]
                if times.attrs["units"] != TIME_UNITS:
                    raise ServiceError(502, "The lightning file is stored in a way this service does not understand.")
                flashes = numpy.empty(times.shape[0], FLASH)
                flashes["time"] = numpy.floor(times[:] + TAI93_TO_UNIX)
                flashes["lat"] = file[FLASH_LATITUDE][:]
                flashes["lon"] = file[FLASH_LONGITUDE][:]
    except ServiceError:
        raise
    except Exception:
        if remote.missing is None:
            raise
    # A list can also look absent only because the part naming it was not there yet.
    return flashes if remote.missing is None else remote.missing


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


def flash_path(url):
    return CACHE_DIR / (orbit_name(url) + ".bin")


def list_path(day):
    return CACHE_DIR / (date_of(day) + ".json")


# Written under another name first, so a cache file is never left half written.
def save(path, content):
    CACHE_DIR.mkdir(exist_ok=True)
    unfinished = path.with_name(path.name + ".part")
    unfinished.write_bytes(content)
    unfinished.replace(path)


# Extracts the flashes of one orbit file into the cache. An orbit file is a few megabytes, of
# which this downloads about 140 kilobytes: its first block, the usual place of the flash lists,
# and then whatever else the file's own layout points at, in larger pieces each time.
def cache_flashes(url, token):
    address = signed_address(url, token)
    blocks = {}

    def fetch(first, count):
        size, fetched = fetch_blocks(address, first, count)
        blocks.update((first + i, block) for i, block in enumerate(fetched))
        return size

    size = fetch(0, 1)
    if USUAL_BLOCKS[0] * BLOCK < size:
        fetch(*USUAL_BLOCKS)
    for attempt in range(MAX_ROUNDS):
        result = read_flashes(size, blocks)
        if not isinstance(result, int):
            save(flash_path(url), result.tobytes())
            return
        fetch(result, min(4 ** (attempt + 1), 256))
    raise ServiceError(502, "Could not read the layout of NASA's lightning files.")


def date_of(day):
    return datetime.fromtimestamp(day * DAY, timezone.utc).strftime("%Y-%m-%d")


def seconds(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


# The download links of the orbit files that hold these days. Which files hold a day is asked of
# NASA's public catalog once and kept on disk, so a day that is fully cached needs no request at all.
def files_for(days):
    if not all(list_path(day).exists() for day in days):
        with writing:
            unlisted = [day for day in days if not list_path(day).exists()]
            if unlisted:
                list_days(unlisted)
    return {url for day in days for url in json.loads(list_path(day).read_text())}


# Asks the catalog for every orbit file from the first to the last of these days with one request,
# and saves the list of each day.
def list_days(days):
    moment = lambda time: datetime.fromtimestamp(time, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    response = http.get(CATALOG_URL, timeout=60, params={
        "collection_concept_id": SPACE_STATION_LIGHTNING, "page_size": 2000,
        "readable_granule_name": "*.nc", "options[readable_granule_name][pattern]": "true",
        "temporal": f"{moment(days[0] * DAY - CATALOG_SLACK)},{moment((days[-1] + 1) * DAY + CATALOG_SLACK)}"})
    response.raise_for_status()
    orbits = []
    for entry in response.json()["feed"]["entry"]:
        for link in entry["links"]:
            if link["rel"].endswith("/data#") and ORBIT_FILE.fullmatch(link["href"]):
                orbits.append((seconds(entry["time_start"]), seconds(entry["time_end"]), link["href"]))
    for day in days:
        save(list_path(day), json.dumps(sorted(
            url for start, end, url in orbits
            if start - CATALOG_SLACK < (day + 1) * DAY and end + CATALOG_SLACK >= day * DAY)).encode())


# Makes sure every one of these orbit files is in the cache. Only one lookup downloads at a time,
# which keeps the number of requests in flight at MAX_REQUESTS however many lookups arrive.
# The token is only needed, and only looked for, when something has to be downloaded.
def fill_cache(urls):
    if all(flash_path(url).exists() for url in urls):
        return
    token = load_token()
    with writing:
        missing = [url for url in urls if not flash_path(url).exists()]
        if not missing:
            return
        workers = ThreadPoolExecutor(max_workers=min(MAX_REQUESTS, len(missing)))
        try:
            list(workers.map(lambda url: cache_flashes(url, token), missing))
        finally:
            # After a failure, the files not yet started are dropped. Those finished stay cached.
            workers.shutdown(cancel_futures=True)


def parse_number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return math.nan


# Accepts seconds since the Unix epoch or a date such as "2019-07-01".
def parse_time(text):
    if text is None:
        return math.nan
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


# The number of lightning flashes seen within `radius` kilometres of one point on each UTC day,
# by the Lightning Imaging Sensor on the International Space Station (ISS LIS V3 science data,
# March 2017 to November 2023). One value per day whose midnight is inside the time range.
# The sensor watches a place for about a minute and a half as it passes, a few times a day at
# most, and never beyond about 55 degrees north or south, so a zero does not mean a calm day.
# Days that are not in the cache yet are fetched from NASA, which needs the service's token.
# Days already in the cache need none.
@app.get("/api/lightning/flashes")
def flashes(lat: str | None = None, lon: str | None = None, start: str | None = None, end: str | None = None,
            radius: str | None = None, pitch: str | None = None, low: str | None = None, high: str | None = None):
    pitch_settings = pitch_options(pitch, low, high)
    latitude, longitude = parse_number(lat), parse_number(lon)
    first, last = parse_time(start), parse_time(end)
    reach = DEFAULT_RADIUS if radius is None else parse_number(radius)
    if math.isnan(first) or math.isnan(last) or last < first:
        raise ServiceError(400, "Start and end times must be valid, with the end not before the start.")
    if not math.isfinite(latitude) or not math.isfinite(longitude) or not -90 <= latitude <= 90:
        raise ServiceError(400, "Latitude must be between -90 and 90 and longitude must be a number.")
    if not math.isfinite(reach) or reach <= 0:
        raise ServiceError(400, "Radius must be a number of kilometres above zero.")
    days = range(max(FIRST_DAY, math.ceil(first / DAY)), min(LAST_DAY, math.floor(last / DAY)) + 1)
    if len(days) > MAX_DAYS:
        raise ServiceError(400, f"At most {MAX_DAYS} days can be looked up at once, and this range has {len(days)}.")
    if not days:
        return []

    urls = sorted(files_for(days))
    fill_cache(urls)
    seen = numpy.concatenate([numpy.fromfile(flash_path(url), FLASH) for url in urls] + [numpy.empty(0, FLASH)])
    there, here = numpy.radians(seen["lat"].astype("f8")), math.radians(latitude)
    across = numpy.radians(seen["lon"].astype("f8") - longitude)
    chord = numpy.sin((there - here) / 2) ** 2 + math.cos(here) * numpy.cos(there) * numpy.sin(across / 2) ** 2
    near = 2 * EARTH_RADIUS * numpy.arcsin(numpy.sqrt(chord)) <= reach
    day_of = seen["time"][near] // DAY
    counts = numpy.bincount(day_of[(day_of >= days[0]) & (day_of <= days[-1])] - days[0], minlength=len(days))
    return add_pitch([{"timestamp": day * DAY, "date": date_of(day), "value": int(count)}
                      for day, count in zip(days, counts)], pitch_settings)


# The first requests to NASA are slower than later ones, so the service makes some while it
# starts instead of leaving that wait to the first lookup.
def warm_up():
    try:
        token = load_token()
        response = http.get(CATALOG_URL, timeout=60, params={
            "collection_concept_id": SPACE_STATION_LIGHTNING, "page_size": MAX_REQUESTS,
            "readable_granule_name": "*.nc", "options[readable_granule_name][pattern]": "true"})
        response.raise_for_status()
        urls = [link["href"] for entry in response.json()["feed"]["entry"] for link in entry["links"]
                if link["rel"].endswith("/data#") and ORBIT_FILE.fullmatch(link["href"])]
        with ThreadPoolExecutor(max_workers=len(urls)) as workers:
            list(workers.map(lambda url: fetch_blocks(signed_address(url, token), 0, 1), urls))
        print("Ready.", flush=True)
    except Exception:
        print("Could not reach NASA while starting. Lookups will try again when asked.", flush=True)
    finally:
        warm.set()


@app.get("/api/lightning/ready")
def ready():
    return JSONResponse({"ready": warm.is_set()}, status_code=200 if warm.is_set() else 503)


@app.exception_handler(404)
def unknown_address(request, error):
    return JSONResponse({"error": "Unknown API address."}, status_code=404)


if __name__ == "__main__":
    port = 8002
    for argument in sys.argv[1:]:
        if not argument.isdigit():
            raise SystemExit("The only thing to give when starting is a port number. "
                             "The NASA token is read from the EARTHDATA_TOKEN environment variable.")
        port = int(argument)
    print(f"The lightning service is running at http://127.0.0.1:{port}")
    try:
        load_token()
    except ServiceError as error:
        print(error.message + " Until then only days already in the cache can be looked up.")
    else:
        print("Opening connections to NASA, which takes a few seconds.")
        warm.clear()
        Thread(target=warm_up, daemon=True).start()
    print("Press Ctrl+C to stop.", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
