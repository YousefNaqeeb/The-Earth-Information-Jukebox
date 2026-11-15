const SERVICE_URL = "http://127.0.0.1:8003/api/pollution";
const NOT_RUNNING = "The air pollution service did not answer. Start it in a terminal with: node API/pollution_api.mjs";

// Accepts a Date, a date string such as "2024-07-20", or a number of seconds since the Unix epoch.
function toUnixSeconds(time) {
    if (time instanceof Date) {
        return time.getTime() / 1000;
    }
    if (typeof time === "string") {
        return Date.parse(time) / 1000;
    }
    return time;
}

// True when the air pollution service is running.
export async function isPollutionReady(serviceUrl = SERVICE_URL) {
    try {
        return (await fetch(`${serviceUrl}/ready`)).ok;
    } catch {
        return false;
    }
}

// Air pollution at one point from NASA's GEOS-CF model, which has a value for every hour from
// January 2018 to 2 January 2026.
// Returns [{ timestamp, date, value }] with timestamp in seconds since the Unix epoch and date as
// UTC text such as "2024-07-20T00:30Z", ready for the functions in processing.js.
// The lookup runs in the air pollution service (pollution_api.mjs), which must be running. It asks
// NASA only for hours it has not fetched before, so a first lookup can take a while.
// Options:
//   pollutant: "pm25" (the default), "o3", "no2", "co" or "so2". Fine particles (pm25) are in
//     micrograms per cubic metre, the gases in parts per billion.
//   period: hours between measurements, a whole number. 1 gives every hour, 24 (the default) one a day.
//   pitch: "log" or "linear" makes the service add normalized (0 to 1) and frequency (hertz) to each
//     measurement, with the lowest value at low and the highest at high (220 and 880 unless given).
export async function getPollution(startTime, endTime, lat, lon, options = {}) {
    const { pollutant = "pm25", period, pitch, low, high, serviceUrl = SERVICE_URL } = options;
    const query = new URLSearchParams({
        start: toUnixSeconds(startTime),
        end: toUnixSeconds(endTime),
        lat,
        lon
    });
    if (period !== undefined) query.set("period", period);
    if (pitch !== undefined) query.set("pitch", pitch);
    if (low !== undefined) query.set("low", low);
    if (high !== undefined) query.set("high", high);

    let response;
    let body;
    try {
        response = await fetch(`${serviceUrl}/${encodeURIComponent(pollutant)}?${query}`);
        body = await response.json();
    } catch {
        throw new Error(NOT_RUNNING);
    }
    if (!response.ok) {
        throw new Error(body.error || `The air pollution request failed (${response.status}).`);
    }
    return body;
}
