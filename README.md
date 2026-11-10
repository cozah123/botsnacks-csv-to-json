# BotSnacks CSV to JSON

Turn an invoice or order export into a JSON array. IDs and amount strings keep their original spelling. Conversion requires only Python 3.9 or later. The optional verification service uses Base Sepolia test USDC.

## Local use

```sh
python3 scripts/convert.py -- invoices.csv invoices.json
```

The output directory must already exist. A successful conversion replaces the selected JSON file. Parsing errors leave the previous output intact. A GitHub runner needs Bash, Python 3.9+, and a preceding checkout of the workspace.

## GitHub Actions

For use before publication, copy this directory to `.github/actions/botsnacks-convert` in your own checkout. Then add this step after the checkout step.

```yaml
- name: Convert invoices to JSON
  id: invoices
  uses: ./.github/actions/botsnacks-convert
  with:
    source: data/invoices.csv
    output: data/invoices.json
    show-verification-offer: 'true'
```

The step writes the JSON file and exposes the optional public discovery URL in `steps.invoices.outputs.verification_offer`. The buyer can disable the offer. The action itself makes no network calls and has no wallet integration. A buyer that wants a paid report can use the workflow in SKILL.md with an existing authorized wallet. Completing the actual eligibility and price check requires the chosen key and field mappings.
