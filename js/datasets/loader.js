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

// NASA only gives these datasets to people with an Earthdata login.
const needsToken = new Set(["city-lights", "lightning"]);

// True when the dataset's lookups need the user's NASA Earthdata token, given as options.token.
export function datasetNeedsToken(name) {
    return needsToken.has(name);
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
    return load(startTime, endTime, lat, lon, options);
}
