const SERVICE_URL = "http://127.0.0.1:8001/api/city-lights";
const NOT_RUNNING = "The night lights service did not answer. Start it in a terminal with your NASA token: "
    + "py py/city_lights_api.py path-to-token.txt";

// Accepts a Date, a date string such as "2015-01-01", or a number of seconds since the Unix epoch.
function toUnixSeconds(time) {
    if (time instanceof Date) {
        return time.getTime() / 1000;
    }
    if (typeof time === "string") {
        return Date.parse(time) / 1000;
    }
    return time;
}

// True once the night lights service is running and has finished opening its connections to NASA.
// False while it is still starting, or when it is not running at all.
export async function isCityLightsReady(serviceUrl = SERVICE_URL) {
    try {
        return (await fetch(`${serviceUrl}/ready`)).ok;
    } catch {
        return false;
    }
}

// Yearly night-time brightness at one point, from NASA's Black Marble data, one measurement per year
// from 2012 on. Brightness is in nanowatts per square centimetre per steradian.
// Returns [{ timestamp, date, year, value }] with timestamp in seconds since the Unix epoch, ready for
// the functions in processing.js. Dark places, including the sea, give zeros. The list is empty
// where NASA has no file for that part of the world.
// Pass null for startTime and endTime to get every year.
// The lookup runs in the night lights service, which must be running.
// Options: pitch ("log" or "linear") makes the service add normalized (0 to 1) and frequency (hertz)
// to each measurement, with the darkest year at low and the brightest at high (220 and 880 unless given).
export async function getCityLights(startTime, endTime, lat, lon, options = {}) {
    const { pitch, low, high, serviceUrl = SERVICE_URL } = options;
    const query = new URLSearchParams({ lat, lon });
    if (startTime != null) query.set("start", toUnixSeconds(startTime));
    if (endTime != null) query.set("end", toUnixSeconds(endTime));
    if (pitch !== undefined) query.set("pitch", pitch);
    if (low !== undefined) query.set("low", low);
    if (high !== undefined) query.set("high", high);

    let response;
    let body;
    try {
        response = await fetch(`${serviceUrl}/brightness?${query}`);
        body = await response.json();
    } catch {
        throw new Error(NOT_RUNNING);
    }
    if (!response.ok) {
        throw new Error(body.error || `The night lights request failed (${response.status}).`);
    }
    return body;
}
