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
