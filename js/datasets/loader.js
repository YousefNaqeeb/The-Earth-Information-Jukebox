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

// NASA only gives these datasets to people with an Earthdata login.
const needsToken = new Set(["city-lights", "lightning"]);

// True when the dataset's lookups can take a NASA Earthdata token, given as options.token.
export function datasetNeedsToken(name) {
    return needsToken.has(name);
}

// Where each dataset's service is found at the page's own address when start.mjs serves the page.
const pageAddresses = {
    ocean: "/api/ocean",
    "city-lights": "/api/city-lights",
    lightning: "/api/lightning",
    pollution: "/api/pollution"
};

// start.mjs answers data requests at the page's own address and hands them on to the services.
// Going through it works where the browser cannot reach the services' own ports, as in a GitHub
// Codespace. This asks once whether the page is being served that way.
let throughPage = null;
async function servicesThroughPage() {
    if (throughPage === null) {
        try {
            throughPage = typeof location !== "undefined" && (await fetch("/api/through-page")).ok;
        } catch {
            throughPage = false;
        }
    }
    return throughPage;
}

// Fetches the measurements for one dataset at one place and period.
// Returns [{ timestamp, date, value }] with timestamp in seconds since the Unix epoch,
// ready for the functions in processing.js. The dataset's service must be running.
// Options are passed on to the dataset's own function, for example token for night lights
// and lightning, radius for lightning, or pollutant and period for pollution.
export async function loadDataset(name, startTime, endTime, lat, lon, options = {}) {
    const load = loaders[name];
    if (!load) {
        throw new Error(`Unknown dataset: ${name}`);
    }
    if (options.serviceUrl === undefined && await servicesThroughPage()) {
        options = { ...options, serviceUrl: pageAddresses[name] };
    }
    return load(startTime, endTime, lat, lon, options);
}
