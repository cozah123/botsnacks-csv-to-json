import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { comparison } from '../../scripts/comparison.mjs';
import { writePrivateJson } from '../../scripts/private-json.mjs';
import { catalogHash, shopifyDecision } from './decision.mjs';

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// on_export.py owns the inter-process lock and content-addressed request directory.
async function processBatch(requestFile, policyFile) {
  const directory = dirname(requestFile);
  const batch = basename(directory);
  const stateFile = join(dirname(directory), 'pilot.json');
  const reportFile = join(directory, 'result.json');
  const body = await readFile(requestFile);
  const { job, request_key } = JSON.parse(body);
  const state = await readOptional(stateFile) ?? { payer: null, approvals: {} };
  const saved = state.approvals[batch];
  const cached = await readOptional(reportFile);
  if (!saved && (cached || await readOptional(requestFile + '.authorization'))) {
    return { status: 'needs_review', reason: 'pilot approval state missing' };
  }
  let result = cached;
  if (!cached) {
    if (!saved && Object.keys(state.approvals).length >= 2) return { status: 'pilot_limit' };
    if (saved) {
      result = await comparison(requestFile, undefined, BigInt(saved.amount), saved, { recoverOnly: true });
    }
    if (!result) {
      const quote = await comparison(requestFile);
      if (quote.digest !== createHash('sha256').update(body).digest('hex') ||
          (saved && (saved.amount !== quote.amount || saved.digest !== quote.digest))) {
        return { status: 'needs_review', reason: 'approved terms changed' };
      }
      const { authorize } = await import(pathToFileURL(policyFile).href);
      const signer = await authorize({ ...quote, currency: 'test USDC', job });
      if (!signer) return { status: 'declined' };
      const payer = signer.address?.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(payer ?? '') || (state.payer && state.payer !== payer)) {
        return { status: 'needs_review', reason: 'unexpected pilot wallet' };
      }
      state.payer = payer;
      state.approvals[batch] = quote;
      await writePrivateJson(stateFile, state);
      result = await comparison(requestFile, signer, BigInt(quote.amount), quote);
    }
  }
  const { receipt } = result;
  const approved = state.approvals[batch];
  const quoteId = 'q_' + createHash('sha256').update('botsnacks-public-test-v1:' + request_key).digest('hex');
  if (!approved || !result.paid || result.test_funds !== true || !result.report ||
      receipt?.quote_id !== quoteId || receipt.mode !== 'testnet' || receipt.test_funds !== true ||
      receipt.input_hash !== catalogHash(job) || receipt.report_hash !== catalogHash(result.report) ||
      receipt.settlement?.success !== true ||
      (receipt.settlement.amount != null && String(receipt.settlement.amount) !== approved.amount) ||
      receipt.payer?.toLowerCase() !== state.payer ||
      receipt.settlement?.payer?.toLowerCase() !== state.payer ||
      receipt.network !== 'eip155:84532' || receipt.settlement?.network !== receipt.network ||
      receipt.currency !== 'USDC' || receipt.transaction !== receipt.settlement?.transaction ||
      !/^0x[0-9a-f]{64}$/i.test(receipt.transaction ?? '') ||
      !/^0\.\d{1,6}$/.test(receipt.amount) ||
      BigInt(receipt.amount.slice(2).padEnd(6, '0')) !== BigInt(approved.amount)) {
    return { status: 'needs_review', reason: 'receipt differs from pilot approval' };
  }
  const decision = shopifyDecision(job, result);
  if (!cached) {
    await writePrivateJson(reportFile, { paid: result.paid, test_funds: result.test_funds,
      report: result.report, receipt });
  }
  return { status: cached ? 'cached' : 'delivered', decision, price_test_usdc: receipt.amount,
    transaction: receipt.transaction, report_file: reportFile };
}

try {
  const outcome = await processBatch(...process.argv.slice(2));
  console.log(JSON.stringify(outcome));
  if (outcome.decision !== 'pass') process.exitCode = outcome.decision === 'hold' ? 1 : 2;
} catch {
  console.error('{"status":"needs_review","reason":"keep private state and retry the same export"}');
  process.exitCode = 2;
}
