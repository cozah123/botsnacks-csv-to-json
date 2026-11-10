"""Prepare a private SKU comparison or request a free quote for the bundled sample."""

import argparse
import base64
import csv
import json
import io
import secrets
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from convert import convert_csv, write_private_request

OFFER_PATH = Path(__file__).resolve().parents[1] / "offers" / "catalog-import.json"
ENDPOINT = "https://botsnacks-testnet-api.cozah.chatgpt.site/api/v1/verify-transform"


def unique_fields(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("A JSON object has duplicate field names.")
        result[name] = value
    return result


def catalog_rows(path):
    if path.suffix.lower() == ".csv":
        rows = convert_csv(path.read_bytes())
    elif path.suffix.lower() == ".json":
        with path.open(encoding="utf-8-sig") as file:
            rows = json.load(file, parse_float=Decimal, object_pairs_hook=unique_fields)
    else:
        raise ValueError("Use CSV or a JSON array for each catalog.")
    if not isinstance(rows, list) or len(rows) > 5000:
        raise ValueError("Provide up to 5,000 rows in each catalog.")
    projected = []
    seen = set()
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Row {index} must be a record.")
        sku = row.get("sku")
        if not isinstance(sku, str) or not sku.strip() or sku in seen:
            raise ValueError(f"Row {index} needs a unique text SKU for this catalog.")
        seen.add(sku)
        price, currency = row.get("price"), row.get("currency")
        if type(price) not in (int, str, Decimal) or not str(price).strip():
            raise ValueError(f"Row {index} needs a price in numeric units.")
        if not isinstance(currency, str) or not currency.strip():
            raise ValueError(f"Row {index} needs a currency code.")
        projected.append({"sku": sku, "price": str(price), "currency": currency})
    return projected


def store_export_job(source_path, csv_path):
    """Compare a single Shopify feed snapshot with its exported variants.csv."""
    with source_path.open(encoding="utf-8-sig") as file:
        feed = json.load(file, parse_float=Decimal, object_pairs_hook=unique_fields)
    if not isinstance(feed, dict) or not isinstance(feed.get("products"), list):
        raise ValueError("Expected a Shopify feed with a products array.")
    variants = []
    for product in feed["products"]:
        if not isinstance(product, dict) or not isinstance(product.get("variants"), list):
            raise ValueError("Each product must supply its variants array.")
        variants.extend(product["variants"])

    data = csv_path.read_bytes()
    headers = next(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline=""), strict=True), [])
    if not {"id", "sku", "price"}.issubset(headers):
        raise ValueError("Expected id, sku and price columns from variants.csv.")
    target = convert_csv(data)
    if not variants or max(len(variants), len(target)) > 5000:
        raise ValueError("Select a nonempty source and at most 5,000 variants per file.")

    def project(row):
        if not isinstance(row, dict):
            raise ValueError("Expected a variant record.")
        identity, sku, price = row.get("id"), row.get("sku"), row.get("price")
        if type(identity) not in (str, int) or not str(identity).strip():
            raise ValueError("Each variant needs its original variant ID.")
        if not isinstance(sku, str) or type(price) not in (str, int, Decimal):
            raise ValueError("Each variant needs a text SKU and a price.")
        return {"id": str(identity), "sku": sku, "price": str(price)}

    return {"source": {"format": "json", "data": [project(v) for v in variants]},
            "target": {"format": "json", "data": [project(v) for v in target]},
            "key": {"source": "id", "target": "id"},
            "fields": [{"source": "sku", "target": "sku", "type": "exact"},
                       {"source": "price", "target": "price", "type": "decimal"}]}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def practice(job, clean):
    """Run the local, synthetic catalog fixture only."""
    source = convert_csv(job["source"]["data"].encode())
    target = source if clean else job["target"]["data"]
    findings = []
    def by_sku(rows):
        items = {row["sku"]: row for row in rows}
        if len(items) != len(rows) or not items or not all(items):
            raise ValueError("Practice fixture needs nonempty, unique SKUs.")
        return items
    before, after = by_sku(source), by_sku(target)
    for sku in sorted(before.keys() | after.keys()):
        if sku not in before or sku not in after:
            findings.append({"code": "missing_record" if sku in before else "unexpected_record", "sku": sku})
            continue
        for field in ("price", "currency"):
            left, right = before[sku][field], after[sku][field]
            if field == "price":
                a, b = Decimal(left), Decimal(right)
                if not a.is_finite() or not b.is_finite():
                    raise ValueError("Practice prices must be finite.")
                changed = a != b
            else:
                changed = left != right
            if changed:
                findings.append({"code": "changed_value", "sku": sku, "field": field,
                                 "source_value": left, "target_value": right})
    print(json.dumps({"mode": "local_practice", "decision": "hold" if findings else "pass",
                      "charged": False, "findings": findings}))
    return 1 if findings else 0


def request_quote(body):
    req = Request(ENDPOINT, data=body, headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "BotSnacks-Catalog-Example/1.0",
    })
    try:
        with build_opener(NoRedirect).open(req, timeout=30) as reply:
            raise ValueError(f"Expected a free HTTP 402 quote, received {reply.status}.")
    except HTTPError as reply:
        with reply:
            if reply.code != 402:
                raise ValueError(f"Expected a free HTTP 402 quote, received {reply.code}.")
            terms = json.load(reply)
            header = json.loads(base64.b64decode(reply.headers.get("PAYMENT-REQUIRED", ""), validate=True))
    if not isinstance(terms, dict) or terms != header or terms.get("x402Version") != 2:
        raise ValueError("The payment header and body must agree on the x402 v2 quote.")
    resource, offers = terms.get("resource", {}), terms.get("accepts", [])
    if not isinstance(resource, dict) or resource.get("url") != ENDPOINT or not isinstance(offers, list) or len(offers) != 1:
        raise ValueError("Unexpected catalog quote resource or number of offers.")
    offer = offers[0]
    expected = {"network": "eip155:84532", "scheme": "exact",
                "asset": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
                "payTo": "0x90b363b82bbffc5552d6635c8af959348117a7f3"}
    if not isinstance(offer, dict) or any(str(offer.get(k)).lower() != v for k, v in expected.items()):
        raise ValueError("Unexpected network, price, token, recipient or payment scheme.")
    amount = offer.get("amount")
    if not isinstance(amount, str) or not amount.isascii() or not amount.isdigit() or len(amount) > 24 or int(amount) <= 0:
        raise ValueError("Expected a positive atomic test USDC amount.")
    price = format(Decimal(amount).scaleb(-6), "f").rstrip("0").rstrip(".")
    print(json.dumps({"http": 402, "network": "Base Sepolia", "price_test_usdc": price, "charged": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("quote-example", help="Send only the bundled synthetic example for an unsigned quote.")
    demo = commands.add_parser("practice", help="Run a synthetic catalog check entirely offline.")
    demo.add_argument("--clean", action="store_true", help="Use a matching target to exercise the pass branch.")
    quote = commands.add_parser("quote", help="Send a prepared private request for a free quote; never signs or pays.")
    quote.add_argument("request", type=Path)
    prep = commands.add_parser("prepare", help="Create a private request locally for a real import.")
    store = commands.add_parser("prepare-store-export", help="Prepare a Shopify feed and Store Catalog Exporter variants.csv locally.")
    for command in (prep, store):
        command.add_argument("source", type=Path)
        command.add_argument("target", type=Path)
        command.add_argument("request", type=Path)
    args = parser.parse_args()
    example = json.loads(OFFER_PATH.read_text(encoding="utf-8"))["example_job"]
    if args.command == "practice":
        return practice(example, args.clean)
    if args.command == "quote-example":
        sample = {"job": example, "request_key": "bs_qa_" + secrets.token_urlsafe(32)}
        request_quote(json.dumps(sample).encode())
        return
    if args.command == "quote":
        if args.request.stat().st_size > 1_000_000:
            raise ValueError("The prepared request exceeds the service limit.")
        body = args.request.read_bytes()
        payload = json.loads(body)
        if not isinstance(payload, dict) or set(payload) != {"job", "request_key"}:
            raise ValueError("Select a prepared comparison request file.")
        request_quote(body)
        return
    if args.source.samefile(args.target):
        raise ValueError("Choose the supplier snapshot and the output from the same import.")
    if args.request.exists():
        raise ValueError("Reuse the existing private request or choose a new file.")
    if args.command == "prepare-store-export":
        write_private_request(store_export_job(args.source, args.target), args.request)
        print("Private store export comparison prepared locally.")
        return
    source, target = catalog_rows(args.source), catalog_rows(args.target)
    if not source:
        raise ValueError("Provide at least one source SKU.")
    job = {"source": {"format": "json", "data": source}, "target": {"format": "json", "data": target},
           "key": example["key"], "fields": example["fields"]}
    write_private_request(job, args.request)
    print("Private request prepared locally.")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, URLError, ValueError, InvalidOperation, KeyError, TypeError, csv.Error) as error:
        print(json.dumps({"decision": "no_verdict", "error": str(error), "charged": False}), file=sys.stderr)
        sys.exit(2)
