# BotSnacks CSV to JSON

Turn an invoice or order export into a JSON array. IDs and amount strings keep their original spelling. Conversion requires only Python 3.9 or later. The optional verification service uses Base Sepolia test USDC.

## Find missing form submissions after spam filtering or CRM import

**Did any leads disappear?** Compare the submission IDs your filter marked **keep** with the IDs that reached your CRM in the **same completed import**. If 48 inquiries were kept and only 46 arrived, the report identifies the missing IDs. You can also check whether a routing status changed.

An intake bot can prepare the comparison locally. Use an existing private directory and opaque IDs from both exports. The preparation step selects only `submission_id` by default. Either input can be CSV or a JSON array.

```sh
python3 scripts/convert.py --prepare-crm-check /private/batch-17/request.json -- kept.csv crm.json
```

**Free job quote. One eligible report costs 0.03 test USDC on Base Sepolia.** Keep the request and original authorization to retrieve the same purchased report for free. [Machine-readable offer](./offers/crm-import.json) · [Quote and checkout instructions](./SKILL.md#reconcile-a-kept-intake-batch-with-its-crm-import)

## Find price changes after a catalog import

**Did any prices change during my catalog import?** Run this after a supplier feed is converted and before the store publishes the catalog. In the three-product example, every SKU arrives, but SKU-001 changes from 19.99 USD to 199.90 USD. Reordered products and equivalent decimals such as 8.50 and 8.5 pass.

From this repository, request a **free testnet quote** for that example in one call. The command sends synthetic data and has no wallet or signing step.

```sh
python3 scripts/catalog.py quote-example
```

A buyer can use its own import and select only SKU, price and currency. One eligible report costs **0.03 test USDC on Base Sepolia**. [Machine-readable offer and expected example](./offers/catalog-import.json) · [Prepare a private import, buy and retrieve](./SKILL.md#check-prices-after-a-catalog-import)

## Check a schedule before posting

Compare the official schedule with the posts a bot has queued. The report identifies missing events and changes to a start time, venue or ticket link. **0.03 test USDC per eligible completed comparison on Base Sepolia.**

[Import Check Before You Post into n8n](https://raw.githubusercontent.com/cozah123/botsnacks-csv-to-json/main/Check-Before-You-Post.n8n.json). Run **Try the screening example** for a free, local preview. A scheduling bot can also call it as an n8n sub-workflow.

A scheduler can request a free quote for a specific schedule with `checkout_action: "quote"` and a stable batch ID. This sends the selected fields and never makes a payment. Wallet-enabled schedulers can purchase and retrieve during the same run. [Connect the buyer's existing wallet](./SKILL.md#scheduling-bot-checkout). Pass `purchase` with a stable batch ID for a schedule revision, then `retrieve` with the same batch. Connect the social posting step only to a strict `publish_ready === true` check.

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
