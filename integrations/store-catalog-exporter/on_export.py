"""Handle a completed Shopify export on a buyer-owned POSIX worker."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "scripts"))
from catalog import store_export_job, request_quote
from convert import write_private_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("products", type=Path)
    parser.add_argument("variants", type=Path)
    parser.add_argument("state", type=Path, help="Dedicated, durable private directory for this pilot.")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--quote", action="store_true", help="Send selected fields for a free quote.")
    modes.add_argument("--policy", type=Path, help="Trusted local buyer module exporting authorize().")
    args = parser.parse_args()
    os.umask(0o077)
    job = store_export_job(args.products, args.variants)
    for side in ("source", "target"):
        job[side]["data"].sort(key=lambda row: row["id"])
    content = json.dumps(job, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    batch = hashlib.sha256(content).hexdigest()
    root = args.state.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.stat().st_mode & 0o077:
        parser.error("Use a private state directory accessible only to this buyer.")
    with (root / "pilot.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        directory = root / batch
        directory.mkdir(mode=0o700, exist_ok=True)
        request = directory / "request.json"
        if request.exists():
            if json.loads(request.read_bytes())["job"] != job:
                raise ValueError("Stored request no longer matches the batch.")
        else:
            write_private_request(job, request)
        if args.policy:
            return subprocess.run(["node", str(HERE / "pilot.mjs"), str(request),
                                   str(args.policy.resolve())], pass_fds=(lock.fileno(),)).returncode
        if args.quote:
            request_quote(request.read_bytes())
        else:
            print(json.dumps({"status": "prepared", "network_used": False}))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError):
        print('{"status":"needs_review","reason":"could not prepare or quote the export"}', file=sys.stderr)
        sys.exit(2)
