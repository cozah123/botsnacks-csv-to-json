import csv
import io
import json


def convert_csv(data):
    source = data.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(source, newline=""), strict=True)
    names = next(reader, None)
    if not names or any(not name.strip() for name in names):
        raise ValueError("A CSV header with named columns is required.")
    if len(set(names)) != len(names):
        raise ValueError("Duplicate column names would overwrite values.")
    records = []
    for index, cells in enumerate(reader, start=1):
        if not cells and len(names) == 1:
            cells = [""]
        if len(cells) != len(names):
            raise ValueError(f"CSV record {index} has {len(cells)} fields; expected {len(names)}.")
        records.append(dict(zip(names, cells)))
    return records

import argparse
import os
import sys
import tempfile
from pathlib import Path


def workspace_path(value):
    path = Path(value).resolve()
    workspace = os.environ.get("GITHUB_WORKSPACE")
    if workspace:
        relative = path.relative_to(Path(workspace).resolve())
        if any(part in {".git", ".github"} for part in relative.parts):
            raise ValueError("Choose a data file inside the workspace.")
    return path


def main():
    parser = argparse.ArgumentParser(description="Convert a local CSV export to JSON.")
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    source = workspace_path(args.source)
    output = workspace_path(args.output)
    if source == output or output.suffix.lower() != ".json":
        raise ValueError("Choose a separate .json output file.")
    raw = source.read_bytes()
    rows = convert_csv(raw)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False,
                                     dir=output.parent, prefix=".botsnacks-") as temp:
        name = Path(temp.name)
        try:
            json.dump(rows, temp, ensure_ascii=False, indent=2)
            temp.write("\n")
            temp.close()
            os.replace(name, output)
        finally:
            name.unlink(missing_ok=True)
    can_offer = 0 < len(rows) <= 5000 and len(raw) + len(json.dumps(rows, ensure_ascii=False).encode()) < 1000000
    print("available" if can_offer else "skip")


if __name__ == "__main__":
    try:
        main()
    except (UnicodeError, ValueError, csv.Error, OSError) as error:
        sys.exit(str(error))
