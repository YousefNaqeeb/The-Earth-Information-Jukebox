const DATA_URL = new URL("../../assets/data/OCEAN/", import.meta.url);
const DAY_SECONDS = 86400;

const cache = new Map();
const wholeFiles = new Map();

function cached(key, load) {
    if (!cache.has(key)) {
        cache.set(key, load().catch(error => {
            cache.delete(key);
            throw error;
        }));
    }
    return cache.get(key);
}

function loadIndex(baseUrl) {
    const url = new URL("index.json", baseUrl).href;
    return cached(url, async () => {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Could not load the ocean data index (${response.status}).`);
        }
        return response.json();
    });
}

// Downloads only the requested bytes of a data file, so one point costs a few KB instead of the whole file.
async function readBytes(url, start, length) {
    const whole = wholeFiles.get(url);
    if (whole) {
        return new DataView(whole, start, length);
    }
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
    if (!response.ok) {
        throw new Error(`Could not load ocean data from ${url} (${response.status}).`);
    }
    const buffer = await response.arrayBuffer();
    if (response.status === 206) {
        if (buffer.byteLength !== length) {
            throw new Error("The server returned an unexpected amount of ocean data.");
        }
        return new DataView(buffer);
    }
    // A server that ignores the range sends the whole file. Keep it so later reads need no request.
    wholeFiles.set(url, buffer);
    return new DataView(buffer, start, length);
}

// Accepts a Date, a date string such as "2007-03-25", or a number of seconds since the Unix epoch.
function toUnixSeconds(time) {
    if (time instanceof Date) {
        return time.getTime() / 1000;
    }
    if (typeof time === "string") {
        return Date.parse(time) / 1000;
    }
    if (time > 1e11) {
        throw new Error("Times given as numbers must be in seconds, not milliseconds.");
    }
    return time;
}

async function readOceanVariable(variable, startTime, endTime, lat, lon, baseUrl) {
    const start = toUnixSeconds(startTime);
    const end = toUnixSeconds(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new Error("Start and end times must be valid, with the end not before the start.");
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
        throw new Error("Latitude must be between -90 and 90 and longitude must be a number.");
    }

    const index = await loadIndex(baseUrl);
    const origin = Date.parse(index.origin_date + "T00:00:00Z") / 1000;
    const times = index.days.length;
    const variableNumber = index.variables.indexOf(variable);
    if (variableNumber === -1) {
        throw new Error(`The ocean data has no variable named ${variable}.`);
    }

    let from = 0;
    while (from < times && origin + index.days[from] * DAY_SECONDS < start) from++;
    let to = from;
    while (to < times && origin + index.days[to] * DAY_SECONDS <= end) to++;
    if (to === from) {
        return [];
    }

    const side = index.cells_per_tile_side;
    const rowsTotal = Math.round(180 / index.cell_degrees);
    const colsTotal = Math.round(360 / index.cell_degrees);
    const row = Math.min(rowsTotal - 1, Math.floor((lat + 90) / index.cell_degrees));
    const col = Math.floor((((lon % 360) + 360) % 360) / index.cell_degrees) % colsTotal;
    const tileRow = String(Math.floor(row / side)).padStart(2, "0");
    const tileCol = String(Math.floor(col / side)).padStart(2, "0");
    const name = `tile_${tileRow}_${tileCol}.bin`;
    if (!index.tiles.includes(name)) {
        return [];
    }

    const tileUrl = new URL(name, baseUrl).href;
    const slotBytes = side * side * 2;
    const slots = await cached(`${tileUrl}#slots`, () => readBytes(tileUrl, 0, slotBytes));
    const cell = (row % side) * side + (col % side);
    const slot = slots.getInt16(cell * 2, true);
    if (slot < 0) {
        return [];
    }

    const seriesStart = slotBytes + (slot * index.variables.length + variableNumber) * times * 2;
    const series = await cached(`${tileUrl}#${slot}:${variable}`, () => readBytes(tileUrl, seriesStart, times * 2));
    const scale = index.scale[variable];
    const measurements = [];
    for (let i = from; i < to; i++) {
        const raw = series.getInt16(i * 2, true);
        if (raw === index.missing) continue;
        const timestamp = origin + index.days[i] * DAY_SECONDS;
        measurements.push({
            timestamp,
            date: new Date(timestamp * 1000).toISOString().slice(0, 10),
            value: raw / scale
        });
    }
    return measurements;
}

// Sea surface temperature in degrees Celsius at one point, one measurement every 3 days.
// Returns [{ timestamp, date, value }] with timestamp in seconds since the Unix epoch,
// ready for the functions in processing.js. Returns an empty list on land or outside 1992 to 2019.
export function getOceanTemperature(startTime, endTime, lat, lon, baseUrl = DATA_URL) {
    return readOceanVariable("sst", startTime, endTime, lat, lon, baseUrl);
}
