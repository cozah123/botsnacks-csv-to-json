# AgentProcure two-order checkout

A buyer can run one BotSnacks comparison with its own Base Sepolia wallet. The sample CSV contains orders A and B. The converted JSON drops B and changes A's total from 12.00 to 10.00. The checkout accepts exactly 0.01 test USDC. This pilot runs on the buyer's machine.

## Get a free quote

Use Node.js 24 or newer. From the BotSnacks repository root, run these commands.

```sh
cd integrations/agentprocure
npm ci --ignore-scripts
node pilot.mjs quote
```

The command uses AgentProcure's discovery, ranking and budget functions, submits the two-order sample and checks the returned x402 quote. It needs no wallet or API key. Expected output is `{"status":"quoted","network":"eip155:84532","test_usdc":"0.01","signed":false}`.

## Buy and retrieve

An independent operator who approves one 0.01 test-USDC purchase can use the following command. Run it in the same directory, with an existing funded testnet buyer account configured privately through AgentProcure's usual `PRIVATE_KEY` environment variable. For a managed signer, import `runPilot('purchase', {getSigner})` from `pilot.mjs` and return a viem-compatible local signer from the buyer's policy callback.

```sh
node pilot.mjs purchase
```

The command submits one authorization and then sends the identical authorized request back to the seller to retrieve the report again. Success requires the same receipt and report, a free repeat retrieval, both expected findings, and a successful Base Sepolia transaction containing exactly one 10,000-unit test-USDC transfer from the buyer to BotSnacks. The JSON output includes the report, payer, transaction hash and report hash.

State is private to the buyer and persists at `$XDG_STATE_HOME/botsnacks/agentprocure-two-orders-v1` or, by default, `~/.local/state/botsnacks/agentprocure-two-orders-v1`. Use the same persistent state directory across retries and restarts. Each separate directory can authorize another purchase. Keep its contents private. To retrieve within the seller's retention period or reconcile a lost reply, run:

```sh
node pilot.mjs recover
```

Recovery uses the original authorization and needs no wallet key. If only the signing marker exists after an interruption, reconcile the attempted signature before starting a new purchase. Offline regression checks run with `node --test pilot.test.mjs`.

The two unmodified AgentProcure modules in `upstream/` come from revision `5b09e69677cf7166a54a6157715f05ba46913bf2` under the included MIT license. The BotSnacks adapter supplies the POST body and uses pinned x402 client dependencies for this pilot. [AgentProcure source](https://github.com/naividh/agent-procure/tree/5b09e69677cf7166a54a6157715f05ba46913bf2/agent)
