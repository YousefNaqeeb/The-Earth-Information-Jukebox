import { getOceanTemperature } from "./ocean.js";
import { getCityLights } from "./city-lights.js";
import { getLightning } from "./lightening.js";
import { getPollution } from "./pollution.js";

// One entry per dataset card on the page, keyed by the card's data-dataset value.
const loaders = {
    ocean: getOceanTemperature,
    "city-lights": getCityLights,
    lightning: getLightning,
    pollution: getPollution
};

// The time each dataset covers, and how much of it one lookup may ask for.
// every is "day" when the period is chosen by date and "year" when a place has one value a year.
// maxDays is the longest period one lookup can cover. These repeat limits that the services
// enforce, so they have to change together with the services.
const periods = {
    ocean: { first: "1992-01-08", last: "2019-03-29", every: "day" },
    "city-lights": { first: "2012-01-01", last: "2025-12-31", every: "year" },
    lightning: { first: "2017-03-01", last: "2023-11-16", every: "day", maxDays: 31 },
    pollution: { first: "2018-01-01", last: "2026-01-02", every: "day", maxDays: 400 }
};

// Returns { first, last, every, maxDays } for one dataset, with first and last as "YYYY-MM-DD".
export function datasetPeriod(name) {
    return periods[name];
}

// Fetches the measurements for one dataset at one place and period.
// Returns [{ timestamp, date, value }] with timestamp in seconds since the Unix epoch,
// ready for the functions in processing.js. The dataset's service must be running.
// Options are passed on to the dataset's own function, for example radius for lightning
// or pollutant and period for pollution.
export async function loadDataset(name, startTime, endTime, lat, lon, options = {}) {
    const load = loaders[name];
    if (!load) {
        throw new Error(`Unknown dataset: ${name}`);
    }
    return load(startTime, endTime, lat, lon, options);
}
