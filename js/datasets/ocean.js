const SERVICE_URL = "http://127.0.0.1:8000/api/ocean";
const NOT_RUNNING = "The ocean service did not answer. Start it in a terminal with: node API/server.mjs";

// Accepts a Date, a date string such as "2007-03-25", or a number of seconds since the Unix epoch.
function toUnixSeconds(time) {
    if (time instanceof Date) {
        return time.getTime() / 1000;
    }
    if (typeof time === "string") {
        return Date.parse(time) / 1000;
    }
    return time;
}

// True when the ocean service is running.
export async function isOceanReady(serviceUrl = SERVICE_URL) {
    try {
        return (await fetch(`${serviceUrl}/ready`)).ok;
    } catch {
        return false;
    }
}

// Sea surface temperature in degrees Celsius at one point, one measurement every 3 days.
// Returns [{ timestamp, date, value }] with timestamp in seconds since the Unix epoch,
// ready for the functions in processing.js. Returns an empty list on land or outside 1992 to 2019.
// The lookup runs in the ocean service (server.mjs), which must be running.
// Options: pitch ("log" or "linear") makes the service add normalized (0 to 1) and frequency (hertz)
// to each measurement, with the coldest at low and the warmest at high (220 and 880 unless given).
export async function getOceanTemperature(startTime, endTime, lat, lon, options = {}) {
    const { pitch, low, high, serviceUrl = SERVICE_URL } = options;
    const query = new URLSearchParams({
        start: toUnixSeconds(startTime),
        end: toUnixSeconds(endTime),
        lat,
        lon
    });
    if (pitch !== undefined) query.set("pitch", pitch);
    if (low !== undefined) query.set("low", low);
    if (high !== undefined) query.set("high", high);

    let response;
    let body;
    try {
        response = await fetch(`${serviceUrl}/temperature?${query}`);
        body = await response.json();
    } catch {
        throw new Error(NOT_RUNNING);
    }
    if (!response.ok) {
        throw new Error(body.error || `The ocean data request failed (${response.status}).`);
    }
    return body;
}
