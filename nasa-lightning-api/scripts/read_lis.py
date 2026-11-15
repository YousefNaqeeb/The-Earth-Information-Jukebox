#!/usr/bin/env python3
"""Inspect authorized ISS LIS files and emit configured observations as NDJSON."""

import argparse
import datetime as dt
import json
import math
import os
import sys


def json_value(value):
    if hasattr(value, "item"):
        try:
            value = value.item()
        except (ValueError, TypeError):
            pass
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return str(value)


def open_file(filename):
    extension = os.path.splitext(filename)[1].lower()
    if extension == ".nc":
        try:
            from netCDF4 import Dataset
        except ImportError as error:
            raise RuntimeError("Install Python dependencies with: python3 -m pip install -r requirements.txt") from error
        return "netcdf", Dataset(filename, mode="r")
    if extension == ".hdf":
        try:
            from pyhdf.SD import SD, SDC
        except ImportError as error:
            raise RuntimeError("HDF4 support requires pyhdf and the HDF4 system library; install requirements.txt.") from error
        return "hdf4", SD(filename, SDC.READ)
    raise RuntimeError("Only NASA NetCDF-4 (.nc) and HDF-4 (.hdf) granules are supported.")


def close_file(kind, dataset):
    if kind == "netcdf":
        dataset.close()
    else:
        dataset.end()


def netcdf_inventory(dataset):
    variables = []

    def visit(group, prefix=""):
        for name, variable in group.variables.items():
            path = f"{prefix}{name}"
            variables.append({
                "path": path,
                "dimensions": list(variable.dimensions),
                "shape": list(variable.shape),
                "dtype": str(variable.dtype),
                "attributes": {key: json_value(variable.getncattr(key)) for key in variable.ncattrs()},
            })
        for name, child in group.groups.items():
            visit(child, f"{prefix}{name}/")

    visit(dataset)
    return variables


def hdf4_inventory(dataset):
    variables = []
    for name, (_dimensions, shape, dtype, _attributes) in dataset.datasets().items():
        variable = dataset.select(name)
        variables.append({
            "path": name,
            "dimensions": list(_dimensions),
            "shape": list(shape),
            "dtype": str(dtype),
            "attributes": {key: json_value(value) for key, value in variable.attributes().items()},
        })
        variable.endaccess()
    return variables


def inspect_file(filename):
    kind, dataset = open_file(filename)
    try:
        variables = netcdf_inventory(dataset) if kind == "netcdf" else hdf4_inventory(dataset)
        if kind == "netcdf":
            attributes = {key: json_value(dataset.getncattr(key)) for key in dataset.ncattrs()}
        else:
            attributes = {key: json_value(value) for key, value in dataset.attributes().items()}
        return {"file": os.path.basename(filename), "format": kind, "attributes": attributes, "variables": variables}
    finally:
        close_file(kind, dataset)


def resolve_netcdf(dataset, path):
    pieces = path.strip("/").split("/")
    group = dataset
    for piece in pieces[:-1]:
        if piece not in group.groups:
            raise RuntimeError(f"Variable group not found in this file: {path}")
        group = group.groups[piece]
    if pieces[-1] not in group.variables:
        raise RuntimeError(f"Variable not found in this file: {path}")
    return group.variables[pieces[-1]]


def read_variable(kind, dataset, path):
    import numpy as np

    if kind == "netcdf":
        variable = resolve_netcdf(dataset, path)
        values = np.ma.asarray(variable[:]).reshape(-1)
        return values, {key: variable.getncattr(key) for key in variable.ncattrs()}
    if path not in dataset.datasets():
        raise RuntimeError(f"Variable not found in this file: {path}")
    variable = dataset.select(path)
    values = np.asarray(variable.get()).reshape(-1)
    attributes = variable.attributes()
    fill = attributes.get("_FillValue")
    if fill is not None:
        values = np.ma.masked_equal(values, fill)
    scale = attributes.get("scale_factor")
    offset = attributes.get("add_offset")
    if scale is not None or offset is not None:
        values = values.astype("float64") * (scale if scale is not None else 1) + (offset if offset is not None else 0)
    variable.endaccess()
    return np.ma.asarray(values), attributes


def iso_timestamp(value, attributes):
    import numpy as np

    if value is None or np.ma.is_masked(value):
        return None
    value = json_value(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    elif isinstance(value, (int, float)):
        units = attributes.get("units")
        if not units:
            return None
        try:
            from netCDF4 import num2date

            parsed = num2date(value, units, calendar=attributes.get("calendar", "standard"))
            parsed = dt.datetime(
                parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second,
                parsed.microsecond, tzinfo=dt.timezone.utc
            )
        except (ImportError, ValueError, TypeError, OverflowError):
            return None
    elif isinstance(value, dt.datetime):
        parsed = value
    elif isinstance(value, np.datetime64):
        parsed = value.astype("datetime64[us]").astype(dt.datetime)
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def measurement_value(value):
    import numpy as np

    if value is None or np.ma.is_masked(value):
        return None
    return json_value(value)


def extract_file(filename, mapping):
    import numpy as np

    kind, dataset = open_file(filename)
    try:
        inventory = netcdf_inventory(dataset) if kind == "netcdf" else hdf4_inventory(dataset)
        available = {variable["path"] for variable in inventory}
        required = [mapping["timestamp"], mapping["latitude"], mapping["longitude"]]
        selected = required + mapping.get("measurements", [])
        missing = [path for path in selected if path not in available]
        if missing:
            raise RuntimeError(
                "Configured variable(s) missing from this granule: "
                + ", ".join(missing)
                + ". Inspect each file and configure only variables present in the selected product."
            )

        arrays = {}
        attributes = {}
        for variable_path in selected:
            arrays[variable_path], attributes[variable_path] = read_variable(kind, dataset, variable_path)
        count = len(arrays[mapping["latitude"]])
        for role in required:
            if len(arrays[role]) != count:
                raise RuntimeError(f"Configured coordinate/time variable lengths do not align: {role}")
        for variable_path in mapping.get("measurements", []):
            if len(arrays[variable_path]) != count:
                raise RuntimeError(f"Configured measurement length does not match observation count: {variable_path}")

        yield {"type": "schema", "variables": inventory}
        valid_timestamps = 0
        for index in range(count):
            latitude = measurement_value(arrays[mapping["latitude"]][index])
            longitude = measurement_value(arrays[mapping["longitude"]][index])
            timestamp = iso_timestamp(arrays[mapping["timestamp"]][index], attributes[mapping["timestamp"]])
            if timestamp is not None:
                valid_timestamps += 1
            if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
                continue
            if not math.isfinite(latitude) or not math.isfinite(longitude):
                continue
            if not -90 <= latitude <= 90 or not -180 <= longitude <= 180 or timestamp is None:
                continue

            measurements = {"variables": {}}
            for variable_path in mapping.get("measurements", []):
                measurements["variables"][variable_path] = {
                    "value": measurement_value(arrays[variable_path][index]),
                    "units": json_value(attributes[variable_path].get("units")),
                }
            yield {
                "type": "observation",
                "record": {
                    "recordIndex": index,
                    "timestamp": timestamp,
                    "latitude": float(latitude),
                    "longitude": float(longitude),
                    "lightningMeasurement": measurements,
                },
            }
        if count and not valid_timestamps:
            raise RuntimeError(
                "The configured timestamp variable could not be decoded. Check its values and time units in the inspected file."
            )
    finally:
        close_file(kind, dataset)


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--inspect", metavar="FILE")
    action.add_argument("--extract", metavar="FILE")
    parser.add_argument("--map", help="JSON mapping of timestamp, latitude, longitude, and optional measurements")
    args = parser.parse_args()

    try:
        if args.inspect:
            print(json.dumps(inspect_file(args.inspect), indent=2, allow_nan=False))
            return
        if not args.map:
            raise RuntimeError("--map is required for extraction.")
        mapping = json.loads(args.map)
        for role in ("timestamp", "latitude", "longitude"):
            if not isinstance(mapping.get(role), str):
                raise RuntimeError(f"The variable map must include a string path for {role}.")
        if not isinstance(mapping.get("measurements", []), list):
            raise RuntimeError("The variable map measurements property must be an array.")
        for message in extract_file(args.extract, mapping):
            print(json.dumps(message, separators=(",", ":"), allow_nan=False))
    except Exception as error:
        print(json.dumps({"type": "error", "message": str(error)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
