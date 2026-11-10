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
import re
import secrets
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


def prepare_invoice_check(source, target, request_path, key, amount):
    if not key or not amount or key == amount:
        raise ValueError("Set --key and --decimal-field to two distinct column names.")
    if request_path.exists() or request_path in {source, target}:
        raise ValueError("Choose a new private request file, or reuse the existing one.")
    datasets = []
    for path in (source, target):
        if path.stat().st_size > 1_000_000:
            raise ValueError("The comparison request exceeds the service size limit.")
        datasets.append(path.read_bytes().decode("utf-8-sig"))
    csv_text, json_text = datasets
    rows = convert_csv(csv_text.encode("utf-8"))
    target_rows = json.loads(json_text)
    if not rows or not isinstance(target_rows, list) or not all(isinstance(r, dict) for r in target_rows):
        raise ValueError("Provide a nonempty source CSV and a JSON array of records.")
    if max(len(rows), len(target_rows)) > 5000:
        raise ValueError("The service accepts up to 5,000 rows per dataset.")
    if key not in rows[0] or amount not in rows[0]:
        raise ValueError("The key and decimal field must be columns in the source CSV.")
    job = {
        "source": {"format": "csv", "data": csv_text},
        "target": {"format": "json", "data": json_text},
        "key": {"source": key, "target": key},
        "fields": [{"source": amount, "target": amount, "type": "decimal"}],
    }
    write_private_request(job, request_path)


def write_private_request(job, request_path):
    body = json.dumps({"job": job, "request_key": secrets.token_urlsafe(32)},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > 1_000_000:
        raise ValueError("The encoded comparison request exceeds 1,000,000 bytes.")
    # A concurrent preparation must never replace a saved job or its recovery key.
    with tempfile.NamedTemporaryFile(dir=request_path.parent, delete=False) as temp:
        temp_path = Path(temp.name)
        try:
            temp.write(body)
            temp.flush()
            os.fsync(temp.fileno())
            temp.close()
            os.link(temp_path, request_path)
        finally:
            temp_path.unlink(missing_ok=True)


def crm_records(path, include_status):
    if path.suffix.lower() == ".csv":
        rows = convert_csv(path.read_bytes())
    elif path.suffix.lower() == ".json":
        rows = json.loads(path.read_text(encoding="utf-8-sig"))
    else:
        raise ValueError("Use a CSV or JSON export.")
    if not isinstance(rows, list) or len(rows) > 5000:
        raise ValueError("Provide at most 5,000 records per export.")
    projected = []
    seen = set()
    for position, row in enumerate(rows, start=1):
        key = row.get("submission_id") if isinstance(row, dict) else None
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}", key):
            raise ValueError(f"Row {position} needs an opaque string submission_id.")
        if key in seen:
            raise ValueError(f"Duplicate submission_id at row {position}; choose one import batch.")
        seen.add(key)
        item = {"submission_id": key}
        if include_status and "routing_status" in row:
            status = row["routing_status"]
            if not isinstance(status, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", status):
                raise ValueError(f"Row {position} needs a short routing_status code.")
            item["routing_status"] = status
        projected.append(item)
    return projected


def prepare_crm_check(kept, imported, request_path, include_status):
    if request_path.exists() or request_path in {kept, imported}:
        raise ValueError("Reuse the existing request for this batch, or choose a new private path.")
    if kept == imported:
        raise ValueError("Choose the kept submissions and the matching completed CRM import.")
    source = crm_records(kept, include_status)
    if not source:
        raise ValueError("The kept-submission export must have at least one record.")
    target = crm_records(imported, include_status)
    fields = [{"source":"routing_status", "target":"routing_status", "type":"exact"}] if include_status else []
    job = {
        "source": {"format":"json", "data":source},
        "target": {"format":"json", "data":target},
        "key": {"source":"submission_id", "target":"submission_id"},
        "fields": fields,
    }
    write_private_request(job, request_path)


def main():
    parser = argparse.ArgumentParser(description="Convert a local CSV export to JSON.")
    parser.add_argument("source")
    parser.add_argument("output")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--prepare-check", metavar="PRIVATE_REQUEST_FILE",
                        help="Prepare a comparison with the existing JSON output.")
    parser.add_argument("--key", help="Record ID column for the comparison.")
    parser.add_argument("--decimal-field", help="Amount column to check in both datasets.")
    modes.add_argument("--prepare-crm-check", metavar="PRIVATE_REQUEST_FILE",
                       help="Prepare an ID-only comparison of a kept batch and its completed CRM import.")
    parser.add_argument("--routing-status", action="store_true",
                        help="Also compare the routing_status code for a CRM batch.")
    args = parser.parse_args()
    source = workspace_path(args.source)
    output = workspace_path(args.output)
    if args.prepare_crm_check:
        if args.key is not None or args.decimal_field is not None:
            parser.error("CRM comparisons use submission_id. Use --routing-status for an optional field.")
        prepare_crm_check(source, output, Path(args.prepare_crm_check).absolute(), args.routing_status)
        print("request prepared")
        return
    if args.routing_status:
        parser.error("--routing-status requires --prepare-crm-check.")
    if args.prepare_check:
        prepare_invoice_check(source, output, Path(args.prepare_check).absolute(), args.key, args.decimal_field)
        print("request prepared")
        return
    if args.key is not None or args.decimal_field is not None:
        parser.error("Comparison field options require --prepare-check.")
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
