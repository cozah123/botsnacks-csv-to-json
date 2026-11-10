"""Prepare a private SKU comparison or request a free quote for the bundled sample."""

import argparse
import base64
import csv
import json
import secrets
import sys
from decimal import Decimal
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


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def quote_example(job):
    sample = {"job": job, "request_key": "bs_qa_" + secrets.token_urlsafe(32)}
    req = Request(ENDPOINT, data=json.dumps(sample).encode(), headers={
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
    expected = {"network": "eip155:84532", "scheme": "exact", "amount": "30000",
                "asset": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
                "payTo": "0x90b363b82bbffc5552d6635c8af959348117a7f3"}
    if not isinstance(offer, dict) or any(str(offer.get(k)).lower() != v for k, v in expected.items()):
        raise ValueError("Unexpected network, price, token, recipient or payment scheme.")
    print(json.dumps({"http": 402, "network": "Base Sepolia", "price_test_usdc": "0.03", "charged": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("quote-example", help="Send only the bundled synthetic example for an unsigned quote.")
    prep = commands.add_parser("prepare", help="Create a private request locally for a real import.")
    prep.add_argument("source", type=Path)
    prep.add_argument("target", type=Path)
    prep.add_argument("request", type=Path)
    args = parser.parse_args()
    example = json.loads(OFFER_PATH.read_text(encoding="utf-8"))["example_job"]
    if args.command == "quote-example":
        quote_example(example)
        return
    if args.source.samefile(args.target):
        raise ValueError("Choose the supplier snapshot and the output from the same import.")
    if args.request.exists():
        raise ValueError("Reuse the existing private request or choose a new file.")
    source, target = catalog_rows(args.source), catalog_rows(args.target)
    if not source:
        raise ValueError("Provide at least one source SKU.")
    job = {"source": {"format": "json", "data": source}, "target": {"format": "json", "data": target},
           "key": example["key"], "fields": example["fields"]}
    write_private_request(job, args.request)
    print("Private request prepared locally.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, URLError, ValueError, csv.Error) as error:
        sys.exit(str(error))
