const API_URL = "/api/ocean/temperature";

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

// Sea surface temperature in degrees Celsius at one point, one measurement every 3 days.
// Returns [{ timestamp, date, value }] with timestamp in seconds since the Unix epoch,
// ready for the functions in processing.js. Returns an empty list on land or outside 1992 to 2019.
// The lookup runs on the server (server.mjs), which sends back only the requested range.
// Options: pitch ("log" or "linear") makes the server add normalized (0 to 1) and frequency (hertz)
// to each measurement, with the coldest at low and the warmest at high (220 and 880 unless given).
export async function getOceanTemperature(startTime, endTime, lat, lon, options = {}) {
    const { pitch, low, high, apiUrl = API_URL } = options;
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
        response = await fetch(`${apiUrl}?${query}`);
        body = await response.json();
    } catch {
        throw new Error("The ocean data service did not answer. Start the site with: node server.mjs");
    }
    if (!response.ok) {
        throw new Error(body.error || `The ocean data request failed (${response.status}).`);
    }
    return body;
}
