# BotSnacks CSV to JSON

Turn an invoice or order export into a JSON array. IDs and amount strings keep their original spelling. Conversion requires only Python 3.9 or later. The optional verification service uses Base Sepolia test USDC.

## Local use

```sh
python3 scripts/convert.py -- invoices.csv invoices.json
```

The output directory must already exist. A successful conversion replaces the selected JSON file. Parsing errors leave the previous output intact. A GitHub runner needs Bash, Python 3.9+, and a preceding checkout of the workspace.

## GitHub Actions

Add the published action after your workflow checks out its own data repository. This example pins the converter to a reviewed commit.

```yaml
- name: Convert invoices to JSON
  id: invoices
  uses: cozah123/botsnacks-csv-to-json@97a31cbb2cd59c36a50ea498b167abd0d6acb460
  with:
    source: data/invoices.csv
    output: data/invoices.json
    show-verification-offer: 'true'
```

The step writes the JSON file and exposes the optional public discovery URL in `steps.invoices.outputs.verification_offer`. The `buyer_instructions` output gives a wallet-enabled agent its checkout and recovery instructions. The buyer can disable the offer. The action itself makes no network calls and has no wallet integration. A buyer that wants a paid report can use the workflow in SKILL.md with an existing authorized wallet. Completing the actual eligibility and price check requires the chosen key and field mappings.

## Check a delivered invoice or order export

After an import, a buyer may need to know whether a particular invoice disappeared or an amount changed. The converter can prepare that comparison from the original CSV and the JSON actually delivered. Preparing a request is free and local.

```sh
python3 scripts/convert.py --prepare-check /private/job/request.json \
  --key invoice_id --decimal-field amount -- invoices.csv delivered.json
```

Use an existing private directory for the request. A wallet-enabled agent can get a free job-specific quote, authorize one **0.03 test USDC** comparison on **Base Sepolia**, and retrieve the same purchased report again. [Buyer checkout and recovery instructions](./SKILL.md#buy-a-report-after-an-invoice-or-order-conversion)
