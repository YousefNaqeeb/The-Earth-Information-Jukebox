// uh this is the framework  for da math
export function validateMeasurements(measurements) {
    if (!Array.isArray(measurements) || measurements.length === 0) {
        throw new Error("Measurements must be a non-empty array.");
    }

    for (const point of measurements) {
        if (!Number.isFinite(point.value)) {
            throw new Error("Every measurement must have a finite numerical value.");
        }
    }

    return true;
}
// this is to like find th eminimum and maximum (basically normalizing it)
export function getMinMax(measurements) {
    validateMeasurements(measurements);

    const values = measurements.map(point => point.value);

    return {
        min: Math.min(...values),
        max: Math.max(...values)
    };
}
// normalization, took this from the internet open source
export function normalizeValue(value, min, max) {
    if (![value, min, max].every(Number.isFinite)) {
        throw new Error("Value and range must be finite numbers.");
    }

    if (max < min || value < min || value > max) {
        throw new Error("Value must be within a valid range.");
    }

    if (max === min) {
        return 0.5;
    }

    return (value - min) / (max - min);
}
export function normalizeMeasurements(measurements) {
    const { min, max } = getMinMax(measurements);

    return measurements.map(point => ({
        ...point,
        normalized: normalizeValue(point.value, min, max)
    }));
}

// linear mapping

export function mapLinear(value, outputMin, outputMax) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("Normalized input must be between 0 and 1.");
    }

    if (!Number.isFinite(outputMin) ||
        !Number.isFinite(outputMax) ||
        outputMax < outputMin) {
        throw new Error("Invalid output range.");
    }

    return outputMin + value * (outputMax - outputMin);
}
// log mapping
export function mapLogarithmic(value, outputMin, outputMax) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("Normalized input must be between 0 and 1.");
    }

    if (
        !Number.isFinite(outputMin) ||
        !Number.isFinite(outputMax) ||
        outputMin <= 0 ||
        outputMax <= 0 ||
        outputMax < outputMin
    ) {
        throw new Error("Logarithmic output limits must be positive and valid.");
    }

    return outputMin * Math.pow(outputMax / outputMin, value);
}

// amplitude mapping ( also from open source)
export function mapAmplitude(value, maxAmplitude = 0.8) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("Normalized input must be between 0 and 1.");
    }

    if (!Number.isFinite(maxAmplitude) ||
        maxAmplitude < 0 ||
        maxAmplitude > 1) {
        throw new Error("Maximum amplitude must be between 0 and 1.");
    }

    return value * maxAmplitude;

  //timestamp  to audio
  // GUYS READ THIS: Timestamps MUST be numeric and use the same unit.For example, seconds since the Unix epoch.
  export function mapTimeToAudio(
    timestamp,
    startTime,
    endTime,
    audioDuration
) {
    if (![timestamp, startTime, endTime, audioDuration]
        .every(Number.isFinite)) {
        throw new Error("Time values must be finite numbers.");
    }

    if (endTime <= startTime || audioDuration <= 0) {
        throw new Error("Invalid time range or audio duration.");
    }

    if (timestamp < startTime || timestamp > endTime) {
        throw new Error("Timestamp is outside the selected period.");
    }

    const normalizedTime =
        (timestamp - startTime) / (endTime - startTime);

    return normalizedTime * audioDuration;
}

