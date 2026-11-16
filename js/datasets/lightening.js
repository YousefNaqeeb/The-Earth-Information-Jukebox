const SERVICE_URL = "http://127.0.0.1:8002/api/lightning";
const NOT_RUNNING = "The lightning service did not answer. Start it in a terminal with: py API/lightning_api.py";

// Accepts a Date, a date string such as "2019-10-01", or a number of seconds since the Unix epoch.
function toUnixSeconds(time) {
    if (time instanceof Date) {
        return time.getTime() / 1000;
    }
    if (typeof time === "string") {
        return Date.parse(time) / 1000;
    }
    return time;
}

// True when the lightning service is running.
export async function isLightningReady(serviceUrl = SERVICE_URL) {
    try {
        return (await fetch(`${serviceUrl}/ready`)).ok;
    } catch {
        return false;
    }
}

// The number of lightning flashes seen near one point on each day, by NASA's Lightning Imaging Sensor
// on the International Space Station, from March 2017 to November 2023.
// Returns [{ timestamp, date, value }], one measurement for every UTC day whose midnight is inside the
// time range, with timestamp in seconds since the Unix epoch, ready for the functions in processing.js.
// Days without flashes are included with value 0. The list is empty outside the sensor's years.
// The sensor sees a place for about a minute and a half each time the station passes over, and never
// beyond about 55 degrees north or south, so many days are 0 even where storms are common.
// At most 31 days can be asked for at once. Days nobody has asked for before take about 2 seconds
// each, and are instant from then on.
// The lookup runs in the lightning service, which must be running.
// Options:
//   token: the user's NASA Earthdata token, which NASA requires for this data. It is sent to the
//     service with the request and passed on to NASA. Days somebody has asked for before come from
//     the service's cache and need no token. Other days fail with a message without it.
//   radius: how far from the point a flash may be, in kilometres (100 unless given).
//   pitch: "log" or "linear" makes the service add normalized (0 to 1) and frequency (hertz) to each
//     measurement, with the quietest day at low and the busiest at high (220 and 880 unless given).
export async function getLightning(startTime, endTime, lat, lon, options = {}) {
    const { token, radius, pitch, low, high, serviceUrl = SERVICE_URL } = options;
    const query = new URLSearchParams({ lat, lon });
    if (startTime != null) query.set("start", toUnixSeconds(startTime));
    if (endTime != null) query.set("end", toUnixSeconds(endTime));
    if (radius !== undefined) query.set("radius", radius);
    if (pitch !== undefined) query.set("pitch", pitch);
    if (low !== undefined) query.set("low", low);
    if (high !== undefined) query.set("high", high);

    let response;
    let body;
    try {
        response = await fetch(`${serviceUrl}/flashes?${query}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        body = await response.json();
    } catch {
        throw new Error(NOT_RUNNING);
    }
    if (!response.ok) {
        throw new Error(body.error || `The lightning request failed (${response.status}).`);
    }
    return body;
}
