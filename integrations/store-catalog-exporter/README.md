# Check a completed Shopify export

Use the original Shopify products JSON and variants.csv from the **same export**. Prepare only variant ID, SKU and price. Each variant is matched by ID so a changed SKU can be detected. Work in a private batch directory and reuse the same request on retry. The existing GitHub Action outputs its private request path and exact quoted price.

```sh
python3 scripts/catalog.py prepare-store-export products.json variants.csv /private/batch/request.json
python3 scripts/catalog.py quote /private/batch/request.json
```

The quote costs zero and sends the selected fields. Share only a batch the buyer is authorized to send. To integrate checkout, install `@x402/core@2.19.0` and `@x402/evm@2.19.0` where Node can resolve them from scripts/comparison.mjs. Use a durable private request and its sibling authorization file for recovery across runner restarts. Protect the files from concurrent editing and logs. An ephemeral Actions runner needs buyer-owned persistent state before signing.

From a buyer module at the repository root, use the buyer's existing batch policy and signer. The policy callback below belongs to the buyer. It may decline and must bind its approval to this immutable request, network, test USDC, recipient and quoted amount. No signer is needed for the quote.

```js
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { comparison } from './scripts/comparison.mjs';
import { shopifyDecision } from './integrations/store-catalog-exporter/decision.mjs';

export async function checkExport(requestFile, authorize) {
  const body = await readFile(requestFile);
  const request = JSON.parse(body);
  const quote = await comparison(requestFile);
  if (quote.digest !== createHash('sha256').update(body).digest('hex')) throw Error('Batch changed');
  const signer = await authorize({ job: request.job, ...quote, currency: 'test USDC' });
  if (!signer) return { status: 'quoted', decision: 'needs_review' };
  const result = await comparison(requestFile, signer, BigInt(quote.amount), quote);
  return { status: 'delivered', decision: shopifyDecision(request.job, result) };
}
```

Use `pass` for a complete clean comparison, `hold` for a complete report with differences, and `needs_review` for a partial, unverifiable or mismatched report. Treat a timeout, checkout error or pending settlement as `needs_review`. Recover using the saved private request and original authorization. Publish only after `pass`.
