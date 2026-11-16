import http from "node:http";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMeasurements, mapLinear, mapLogarithmic } from "../js/datasets/processing.js";

// The project's top folder, one level above this file.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OCEAN_DIR = path.join(ROOT, "assets", "data", "OCEAN");
// Port 8000 is left free, since that is where a separate front end server usually runs.
const PORT = Number(process.argv[2]) || 8004;
const DAY_SECONDS = 86400;
const PITCH_METHODS = new Map([["log", mapLogarithmic], ["logarithmic", mapLogarithmic], ["linear", mapLinear]]);
const DEFAULT_LOW_HZ = 220;
const DEFAULT_HIGH_HZ = 880;

const oceanIndex = JSON.parse(await readFile(path.join(OCEAN_DIR, "index.json"), "utf8"));
const oceanOrigin = Date.parse(oceanIndex.origin_date + "T00:00:00Z") / 1000;
const oceanTiles = new Set(oceanIndex.tiles);

class BadRequest extends Error {}

function parseNumber(text) {
    return text === null || text.trim() === "" ? NaN : Number(text);
}

// Accepts seconds since the Unix epoch or a date string such as "2007-03-25".
function parseTime(text) {
    const number = parseNumber(text);
    if (number > 1e11) {
        throw new BadRequest("Times given as numbers must be in seconds, not milliseconds.");
    }
    return Number.isFinite(number) || text === null ? number : Date.parse(text) / 1000;
}

async function readExactly(file, length, position) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    if (bytesRead !== length) {
        throw new Error("An ocean data file is shorter than expected.");
    }
    return buffer;
}

// Reads one variable at one point from the ocean tiles, for the requested time range only.
async function oceanSeries(variable, query) {
    const start = parseTime(query.get("start"));
    const end = parseTime(query.get("end"));
    const lat = parseNumber(query.get("lat"));
    const lon = parseNumber(query.get("lon"));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new BadRequest("Start and end times must be valid, with the end not before the start.");
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
        throw new BadRequest("Latitude must be between -90 and 90 and longitude must be a number.");
    }

    const { days, variables, scale, missing, cell_degrees: cellDegrees, cells_per_tile_side: side } = oceanIndex;
    const times = days.length;
    let from = 0;
    while (from < times && oceanOrigin + days[from] * DAY_SECONDS < start) from++;
    let to = from;
    while (to < times && oceanOrigin + days[to] * DAY_SECONDS <= end) to++;
    if (to === from) {
        return [];
    }

    const rowsTotal = Math.round(180 / cellDegrees);
    const colsTotal = Math.round(360 / cellDegrees);
    const row = Math.min(rowsTotal - 1, Math.floor((lat + 90) / cellDegrees));
    const col = Math.floor((((lon % 360) + 360) % 360) / cellDegrees) % colsTotal;
    const tileRow = String(Math.floor(row / side)).padStart(2, "0");
    const tileCol = String(Math.floor(col / side)).padStart(2, "0");
    const name = `tile_${tileRow}_${tileCol}.bin`;
    if (!oceanTiles.has(name)) {
        return [];
    }

    const file = await open(path.join(OCEAN_DIR, name));
    try {
        const cell = (row % side) * side + (col % side);
        const slot = (await readExactly(file, 2, cell * 2)).readInt16LE(0);
        if (slot < 0) {
            return [];
        }
        const seriesStart = side * side * 2 + (slot * variables.length + variables.indexOf(variable)) * times * 2;
        const values = await readExactly(file, (to - from) * 2, seriesStart + from * 2);
        const measurements = [];
        for (let i = from; i < to; i++) {
            const raw = values.readInt16LE((i - from) * 2);
            if (raw === missing) continue;
            const timestamp = oceanOrigin + days[i] * DAY_SECONDS;
            measurements.push({
                timestamp,
                date: new Date(timestamp * 1000).toISOString().slice(0, 10),
                value: raw / scale[variable]
            });
        }
        return measurements;
    } finally {
        await file.close();
    }
}

function round(number, decimals) {
    return Math.round(number * 10 ** decimals) / 10 ** decimals;
}

// With pitch=log or pitch=linear in the request, adds a frequency in hertz to each measurement.
// The lowest value in the selection gets the low frequency and the highest gets the high one,
// and the chosen method from processing.js decides how the values in between are spaced.
function addPitch(measurements, query) {
    if (!query.has("pitch")) {
        return measurements;
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
    if (measurements.length === 0) {
        return measurements;
    }
    return normalizeMeasurements(measurements).map(point => ({
        ...point,
        normalized: round(point.normalized, 4),
        frequency: round(method(point.normalized, low, high), 2)
    }));
}

function send(response, status, type, body) {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    response.end(body);
}

function sendJson(response, status, value) {
    send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/api/ocean/temperature") {
            sendJson(response, 200, addPitch(await oceanSeries("sst", url.searchParams), url.searchParams));
        } else if (url.pathname === "/api/ocean/ready") {
            sendJson(response, 200, { ready: true });
        } else {
            sendJson(response, 404, { error: "Unknown API address." });
        }
    } catch (error) {
        if (error instanceof BadRequest) {
            sendJson(response, 400, { error: error.message });
        } else {
            console.error(error);
            sendJson(response, 500, { error: "The server hit an unexpected problem." });
        }
    }
});

server.on("error", error => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Pick another one, for example: node API/server.mjs ${PORT + 1}`);
    } else {
        console.error(error);
    }
    process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`The ocean service is running at http://127.0.0.1:${PORT}`);
    console.log("Press Ctrl+C to stop.");
});
