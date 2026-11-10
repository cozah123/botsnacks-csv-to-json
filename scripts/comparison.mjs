import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

export async function comparison(requestFile, signer, maxAtomic = 30000n, approvedQuote) {
  const url = "https://botsnacks-testnet-api.cozah.chatgpt.site/api/v1/verify-transform";
  const network = "eip155:84532";
  const receiver = "0x90b363b82bbffc5552d6635c8af959348117a7f3";
  const usdc = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  const prices = new Map([["10000","0.01"],["30000","0.03"],["50000","0.05"]]);
  const body = await readFile(requestFile);
  const digest = createHash("sha256").update(body).digest("hex");
  if (approvedQuote && (approvedQuote.digest !== digest || !prices.has(approvedQuote.amount)))
    throw new Error("This approval does not match the private batch.");
  const proofFile = requestFile + ".authorization";
  const post = (signature) => fetch(url, {
    method: "POST", redirect: "error", body, signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", "User-Agent": "BotSnacksBuyer/1.0",
      ...(signature ? { "PAYMENT-SIGNATURE": signature } : {}) },
  });
  let saved;
  try { saved = JSON.parse(await readFile(proofFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (saved && (saved.digest !== digest || typeof saved.signature !== "string" || !saved.signature))
    throw new Error("The saved authorization does not match this request.");

  if (!saved || !signer) {
    const quote = await post();
    if (quote.status !== 402) throw new Error("Quote returned HTTP " + quote.status);
    const client = new x402Client();
    const http = new x402HTTPClient(client);
    const terms = http.getPaymentRequiredResponse(k => quote.headers.get(k), await quote.json());
    const [offer] = terms.accepts;
    if (terms.x402Version !== 2 || terms.resource?.url !== url || terms.accepts.length !== 1 ||
        offer.scheme !== "exact" || offer.network !== network || !prices.has(offer.amount) ||
        offer.asset.toLowerCase() !== usdc || offer.payTo.toLowerCase() !== receiver ||
        (offer.extra?.assetTransferMethod && offer.extra.assetTransferMethod !== "eip3009"))
      throw new Error("Unexpected payment terms.");
    if (!signer) return { network, amount: offer.amount, payTo: receiver, digest };
    if (typeof maxAtomic !== "bigint" || BigInt(offer.amount) > maxAtomic) throw new Error("Quote exceeds approved budget.");
    if (approvedQuote && offer.amount !== approvedQuote.amount) throw new Error("Quote changed; renew the batch approval.");
    registerExactEvmScheme(client, { signer, networks: [network] });
    const payload = await client.createPaymentPayload(terms);
    const signature = http.encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"];
    if (!signature) throw new Error("Wallet returned no authorization.");
    saved = { digest, signature, amount: prices.get(offer.amount) };
    // Only the process which creates the file may submit its new signature.
    await writeFile(proofFile, JSON.stringify(saved), { flag: "wx", mode: 0o600, flush: true });
  }
  const accepted = JSON.parse(Buffer.from(saved.signature, "base64").toString("utf8")).accepted;
  if (!prices.has(accepted?.amount) || prices.get(accepted.amount) !== (saved.amount ?? "0.03"))
    throw new Error("Saved authorization amount does not match the quote.");
  if (typeof maxAtomic !== "bigint" || BigInt(accepted.amount) > maxAtomic)
    throw new Error("Saved authorization exceeds the current spending limit. Use the cached report or reconcile the original purchase.");
  if (approvedQuote && accepted.amount !== approvedQuote.amount) throw new Error("Saved terms differ from the batch approval.");
  const response = await post(saved.signature);
  if (response.status !== 200) throw new Error("HTTP " + response.status + "; keep this request and authorization for reconciliation.");
  const result = await response.json();
  const receipt = result.receipt;
  if (!result.paid || result.test_funds !== true || !result.report ||
      receipt?.network !== network || receipt.amount !== prices.get(accepted.amount) || receipt.currency !== "USDC" ||
      !receipt.settlement?.success || receipt.transaction !== receipt.settlement.transaction ||
      !/^0x[0-9a-f]{64}$/i.test(receipt.transaction))
    throw new Error("Could not confirm delivery and settlement; keep the original authorization.");
  return result;
}
