# Python copy of js/datasets/processing.js, for the Python services. Keep the two in step: when a
# function changes there, change it here the same way. Names differ only in style, for example
# normalizeMeasurements there is normalize_measurements here, and a thrown Error is a ValueError.
import math


# The same test as JavaScript's Number.isFinite: a real, finite number, not text and not true or false.
def is_finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_measurements(measurements):
    if not isinstance(measurements, list) or len(measurements) == 0:
        raise ValueError("Measurements must be a non-empty array.")

    for point in measurements:
        if not is_finite_number(point.get("value") if isinstance(point, dict) else None):
            raise ValueError("Every measurement must have a finite numerical value.")

    return True


def get_min_max(measurements):
    validate_measurements(measurements)

    values = [point["value"] for point in measurements]

    return {"min": min(values), "max": max(values)}


def normalize_value(value, minimum, maximum):
    if not all(is_finite_number(number) for number in (value, minimum, maximum)):
        raise ValueError("Value and range must be finite numbers.")

    if maximum < minimum or value < minimum or value > maximum:
        raise ValueError("Value must be within a valid range.")

    if maximum == minimum:
        return 0.5

    return (value - minimum) / (maximum - minimum)


def normalize_measurements(measurements):
    limits = get_min_max(measurements)

    return [{**point, "normalized": normalize_value(point["value"], limits["min"], limits["max"])}
            for point in measurements]


def map_linear(value, output_min, output_max):
    if not is_finite_number(value) or value < 0 or value > 1:
        raise ValueError("Normalized input must be between 0 and 1.")

    if not is_finite_number(output_min) or not is_finite_number(output_max) or output_max < output_min:
        raise ValueError("Invalid output range.")

    return output_min + value * (output_max - output_min)


def map_logarithmic(value, output_min, output_max):
    if not is_finite_number(value) or value < 0 or value > 1:
        raise ValueError("Normalized input must be between 0 and 1.")

    if (not is_finite_number(output_min) or not is_finite_number(output_max)
            or output_min <= 0 or output_max <= 0 or output_max < output_min):
        raise ValueError("Logarithmic output limits must be positive and valid.")

    return output_min * math.pow(output_max / output_min, value)


def map_amplitude(value, max_amplitude=0.8):
    if not is_finite_number(value) or value < 0 or value > 1:
        raise ValueError("Normalized input must be between 0 and 1.")

    if not is_finite_number(max_amplitude) or max_amplitude < 0.05 or max_amplitude > 1:
        raise ValueError("Maximum amplitude must be between 0.05 and 1.")

    return 0.05 + value * (max_amplitude - 0.05)


# Timestamps must be numbers in the same unit, for example seconds since the Unix epoch.
def map_time_to_audio(timestamp, start_time, end_time, audio_duration):
    if not all(is_finite_number(number) for number in (timestamp, start_time, end_time, audio_duration)):
        raise ValueError("Time values must be finite numbers.")

    if end_time <= start_time or audio_duration <= 0:
        raise ValueError("Invalid time range or audio duration.")

    if timestamp < start_time or timestamp > end_time:
        raise ValueError("Timestamp is outside the selected period.")

    normalized_time = (timestamp - start_time) / (end_time - start_time)

    return normalized_time * audio_duration
