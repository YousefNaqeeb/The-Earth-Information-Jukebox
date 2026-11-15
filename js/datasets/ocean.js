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
export async function getOceanTemperature(startTime, endTime, lat, lon, apiUrl = API_URL) {
    const query = new URLSearchParams({
        start: toUnixSeconds(startTime),
        end: toUnixSeconds(endTime),
        lat,
        lon
    });

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
