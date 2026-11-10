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

## Run a two-export pilot

Attach this command to the buyer's existing successful export event. Give it the two files from that run and a dedicated private state directory on a persistent Linux or macOS worker. With no option it prepares the job locally. With `--quote` it sends the selected fields for a free quote. For paid runs use Node 24+, Python 3 and the x402 packages above.

```sh
python3 integrations/store-catalog-exporter/on_export.py \
  products.json variants.csv "$PRIVATE_STATE/botsnacks-pilot" \
  --policy "$BUYER_CONFIG/botsnacks-policy.mjs"
```

The policy module belongs to the buyer. It exports `async function authorize({job, amount, digest, network, payTo, currency})`. Return the buyer's existing authorized x402 EVM signer or `null` to decline. Amount is a string in six-decimal atomic units. For a small-export pilot the buyer can cap each approval at `10000` (0.01 test USDC). A signer needs an `address` and `signTypedData`; keep its key in the buyer's existing wallet system. Use this mode only for exports the buyer permits sending. Use separate state for each buyer.

For example, a buyer that has already authorized these selected fields and at most 0.01 test USDC per report can connect its existing signer this way:

```js
import { catalogWallet } from './existing-buyer-wallet.mjs';

export async function authorize({ amount, network, currency }) {
  if (network !== 'eip155:84532' || currency !== 'test USDC' || BigInt(amount) > 10000n) return null;
  return catalogWallet;
}
```

The pilot reserves up to two distinct comparisons for the same wallet. The second file pair is a new comparison when its selected variant IDs, SKUs or price values differ. A reordered or redelivered pair with identical selected records reuses the saved report. An interrupted payment keeps its slot and original authorization for recovery. Preserve the state directory across restarts, including after an error. Run the Python entry point for every arrival so concurrent workers share the same lock.

Stdout reports the decision, the public transaction ID and the private report file for a completed comparison. Exit 0 with `decision: pass` allows publication, exit 1 with `decision: hold` flags differences, and exit 2 means stop for review, decline or the pilot limit. A local preparation or free quote cannot authorize publication. An outside worker can corroborate two actual export events with the two transaction IDs from its own logs. Keep source files, report contents, request keys and signatures private.
