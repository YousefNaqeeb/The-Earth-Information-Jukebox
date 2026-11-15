import {
    validateMeasurements,
    getMinMax,
    normalizeValue,
    normalizeMeasurements,
    mapLinear,
    mapLogarithmic,
    mapAmplitude,
    mapTimeToAudio
} from "./js/datasets/processing.js";

// SAMPLE DATA

const measurements = [
    { value: 10, timestamp: 100 },
    { value: 30, timestamp: 200 },
    { value: 50, timestamp: 300 }
];

console.log("=== NORMAL TESTS ===");

console.log("Validation:", validateMeasurements(measurements));
console.log("Min/max:", getMinMax(measurements));
console.log("Normalized measurements:", normalizeMeasurements(measurements));

console.log("Normalization:", normalizeValue(30, 10, 50));
console.log("Linear mapping:", mapLinear(0.5, 200, 1000));
console.log("Logarithmic mapping:", mapLogarithmic(0.5, 200, 1000));
console.log("Amplitude mapping:", mapAmplitude(0.5));
console.log("Audio position:", mapTimeToAudio(50, 0, 100, 10));

// ERROR TESTS

function expectError(label, expectedMessage, test) {
    try {
        test();
        console.error(`${label}: FAILED — no error was thrown`);
    } catch (error) {
        if (error.message === expectedMessage) {
            console.log(`${label}: PASSED`);
        } else {
            console.error(`${label}: FAILED — unexpected error: ${error.message}`);
        }
    }
}

console.log("\n=== ERROR TESTS ===");

expectError(
    "Empty dataset",
    "Measurements must be a non-empty array.",
    () => validateMeasurements([])
);

expectError(
    "Missing measurement value",
    "Every measurement must have a finite numerical value.",
    () => validateMeasurements([{ timestamp: 100 }])
);

expectError(
    "Invalid normalization range",
    "Value must be within a valid range.",
    () => normalizeValue(5, 10, 0)
);