import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMeasurements, mapLinear, mapLogarithmic } from "./processing.js";

// The project's top folder, two levels above this file.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = path.join(ROOT, "pollution_cache");
const PORT = Number(process.argv[2]) || 8003;
const NASA_URL = "https://opendap.nccs.nasa.gov/dods/gmao/geos-cf/assim/aqc_tavg_1hr_g1440x721_v1";

// NASA's GEOS-CF model gives one value per hour, stamped at half past the hour, on a quarter
// degree grid. This collection starts at 2018-01-01 00:30 UTC and ends at 2026-01-02 11:30 UTC.
const FIRST_HOUR = Date.UTC(2018, 0, 1, 0, 30) / 1000;
const HOURS_AVAILABLE = 70164;
const GRID_STEP = 0.25;
const MISSING = 1e14;

// Fine particles are in micrograms per cubic metre. The gases are stored as a fraction of air and
// are scaled here to parts per billion.
const POLLUTANTS = new Map([
    ["pm25", { variable: "pm25_rh35_gcc", scale: 1, decimals: 2 }],
    ["o3", { variable: "o3", scale: 1e9, decimals: 2 }],
    ["no2", { variable: "no2", scale: 1e9, decimals: 3 }],
    ["co", { variable: "co", scale: 1e9, decimals: 1 }],
    ["so2", { variable: "so2", scale: 1e9, decimals: 3 }]
]);
const PITCH_METHODS = new Map([["log", mapLogarithmic], ["logarithmic", mapLogarithmic], ["linear", mapLinear]]);
const DEFAULT_LOW_HZ = 220;
const DEFAULT_HIGH_HZ = 880;
const DEFAULT_PERIOD = 24;
const MAX_MEASUREMENTS = 400;

// NASA's server takes time for every hour between the first and last one asked for, even when told
// to skip hours, and now and then a request simply hangs. So hours are fetched in short unbroken
// runs, several requests at a time, each with a short time limit and a few tries. With a period of
// a few hours it is quicker to fetch every hour in between; with a longer one, each hour on its own.
const HOURS_PER_REQUEST = 12;
const REQUESTS_AT_ONCE = 5;
const TRIES = 4;
const FETCH_EVERY_HOUR_UP_TO_PERIOD = 4;

const cells = new Map();

class BadRequest extends Error {}
class NasaUnavailable extends Error {}

function parseNumber(text) {
    return text === null || text.trim() === "" ? NaN : Number(text);
}

// Accepts seconds since the Unix epoch or a date string such as "2024-07-20".
function parseTime(text) {
    const number = parseNumber(text);
    if (number > 1e11) {
        throw new BadRequest("Times given as numbers must be in seconds, not milliseconds.");
    }
    return Number.isFinite(number) || text === null ? number : Date.parse(text) / 1000;
}

function round(number, decimals) {
    return Math.round(number * 10 ** decimals) / 10 ** decimals;
}

// Everything fetched for one pollutant at one grid cell is kept in one small file, as the raw value
// for each hour, so any later lookup there with any period reuses it.
async function loadCell(pollutant, row, col) {
    const file = path.join(CACHE_DIR, pollutant, `${row}_${col}.json`);
    if (!cells.has(file)) {
        let hours = {};
        try {
            hours = JSON.parse(await readFile(file, "utf8"));
        } catch {
            // Nothing cached for this cell yet.
        }
        cells.set(file, { file, hours, busy: Promise.resolve() });
    }
    return cells.get(file);
}

async function fetchRun(variable, row, col, first, last) {
    const url = `${NASA_URL}.ascii?${variable}[${first}:1:${last}][0:0][${row}:${row}][${col}:${col}]`;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(8000 + 1000 * (last - first + 1)) });
            const values = [...(await response.text()).matchAll(/^\[\d+\]\[0\]\[0\], (\S+)$/gm)].map(match => Number(match[1]));
            if (response.ok && values.length === last - first + 1 && values.every(Number.isFinite)) {
                return values;
            }
        } catch {
            // A timeout or a dropped connection is retried like any other failure.
        }
        if (attempt < TRIES) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
    throw new NasaUnavailable();
}

// Fetches the wanted hours that are not cached yet and saves each answer as it arrives, so a lookup
// that fails part way keeps what it got.
async function fillCell(cell, variable, row, col, wanted) {
    const runs = [];
    for (const hour of wanted) {
        if (hour in cell.hours) continue;
        const run = runs[runs.length - 1];
        if (run && hour === run[1] + 1 && hour - run[0] < HOURS_PER_REQUEST) {
            run[1] = hour;
        } else {
            runs.push([hour, hour]);
        }
    }
    if (runs.length === 0) return;

    await mkdir(path.dirname(cell.file), { recursive: true });
    let failed = false;
    let saving = Promise.resolve();
    async function worker() {
        while (runs.length && !failed) {
            const [first, last] = runs.shift();
            try {
                const values = await fetchRun(variable, row, col, first, last);
                values.forEach((value, k) => { cell.hours[first + k] = Math.abs(value) > MISSING ? null : value; });
                saving = saving.then(() => writeFile(cell.file, JSON.stringify(cell.hours)));
            } catch (error) {
                failed = true;
            }
        }
    }
    await Promise.all(Array.from({ length: REQUESTS_AT_ONCE }, worker));
    await saving;
    if (failed) throw new NasaUnavailable();
}

async function pollutionSeries(pollutant, query) {
    const { variable, scale, decimals } = POLLUTANTS.get(pollutant);
    const start = parseTime(query.get("start"));
    const end = parseTime(query.get("end"));
    const lat = parseNumber(query.get("lat"));
    const lon = parseNumber(query.get("lon"));
    const period = query.has("period") ? parseNumber(query.get("period")) : DEFAULT_PERIOD;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new BadRequest("Start and end times must be valid, with the end not before the start.");
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
        throw new BadRequest("Latitude must be between -90 and 90 and longitude must be a number.");
    }
    if (!Number.isInteger(period) || period < 1) {
        throw new BadRequest("Period must be a whole number of hours, 1 or more.");
    }

    const firstHour = Math.max(0, Math.ceil((start - FIRST_HOUR) / 3600));
    const lastHour = Math.min(HOURS_AVAILABLE - 1, Math.floor((end - FIRST_HOUR) / 3600));
    if (lastHour < firstHour) {
        return [];
    }
    const count = Math.floor((lastHour - firstHour) / period) + 1;
    if (count > MAX_MEASUREMENTS) {
        throw new BadRequest(`At most ${MAX_MEASUREMENTS} measurements can be looked up at once, and this range `
            + `with a period of ${period} ${period === 1 ? "hour" : "hours"} has ${count}. Use a longer period or a shorter range.`);
    }
    const wanted = Array.from({ length: count }, (_, k) => firstHour + k * period);
    const toFetch = period <= FETCH_EVERY_HOUR_UP_TO_PERIOD
        ? Array.from({ length: wanted[count - 1] - firstHour + 1 }, (_, k) => firstHour + k)
        : wanted;

    const row = Math.round((lat + 90) / GRID_STEP);
    const col = Math.round(((((lon + 180) % 360) + 360) % 360) / GRID_STEP) % Math.round(360 / GRID_STEP);
    const cell = await loadCell(pollutant, row, col);
    // One lookup at a time per cell, so two requests for the same place never fetch the same hours twice.
    const filled = cell.busy.then(() => fillCell(cell, variable, row, col, toFetch));
    cell.busy = filled.catch(() => {});
    await filled;

    const measurements = [];
    for (const hour of wanted) {
        const raw = cell.hours[hour];
        if (raw === null || raw === undefined) continue;
        const timestamp = FIRST_HOUR + hour * 3600;
        measurements.push({
            timestamp,
            date: new Date(timestamp * 1000).toISOString().slice(0, 16) + "Z",
            value: round(raw * scale, decimals)
        });
    }
    return measurements;
}

// With pitch=log or pitch=linear in the request, adds a frequency in hertz to each measurement.
// The lowest value in the selection gets the low frequency and the highest gets the high one,
// and the chosen method from processing.js decides how the values in between are spaced.
function pitchOptions(query) {
    if (!query.has("pitch")) {
        return null;
    }
    const method = PITCH_METHODS.get(query.get("pitch").trim().toLowerCase());
    if (!method) {
        throw new BadRequest("Pitch must be log or linear.");
    }
    const low = query.has("low") ? parseNumber(query.get("low")) : DEFAULT_LOW_HZ;
    const high = query.has("high") ? parseNumber(query.get("high")) : DEFAULT_HIGH_HZ;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) {
        throw new BadRequest("The pitch range must be two numbers above zero in hertz, with low not above high.");
    }
    return { method, low, high };
}

function addPitch(measurements, options) {
    if (!options || measurements.length === 0) {
        return measurements;
    }
    return normalizeMeasurements(measurements).map(point => ({
        ...point,
        normalized: round(point.normalized, 4),
        frequency: round(options.method(point.normalized, options.low, options.high), 2)
    }));
}

function sendJson(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    });
    response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        const name = url.pathname.startsWith("/api/pollution/") ? url.pathname.slice("/api/pollution/".length) : null;
        if (name === "ready") {
            sendJson(response, 200, { ready: true });
        } else if (name === null) {
            sendJson(response, 404, { error: "Unknown API address." });
        } else if (!POLLUTANTS.has(name)) {
            throw new BadRequest(`The pollutant must be one of: ${[...POLLUTANTS.keys()].join(", ")}.`);
        } else {
            const pitch = pitchOptions(url.searchParams);
            sendJson(response, 200, addPitch(await pollutionSeries(name, url.searchParams), pitch));
        }
    } catch (error) {
        if (error instanceof BadRequest) {
            sendJson(response, 400, { error: error.message });
        } else if (error instanceof NasaUnavailable) {
            sendJson(response, 502, { error: "NASA's air quality server did not answer for part of this range. "
                + "What it did send is saved, so asking again carries on from there." });
        } else {
            console.error(error);
            sendJson(response, 500, { error: "The server hit an unexpected problem." });
        }
    }
});

server.on("error", error => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Pick another one, for example: node js/datasets/pollution_api.mjs ${PORT + 1}`);
    } else {
        console.error(error);
    }
    process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`The air pollution service is running at http://127.0.0.1:${PORT}`);
    console.log("Press Ctrl+C to stop.");
});
