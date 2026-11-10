// Inert signer and in-process HTTP fixture. No transport or wallet is connected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogHash } from '../decision.mjs';

const url = 'https://botsnacks-testnet-api.cozah.chatgpt.site/api/v1/verify-transform';
const recipient = '0x90b363b82bbffc5552d6635c8af959348117a7f3';
const asset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const network = 'eip155:84532';
const payer = '0x' + '1'.repeat(40);
const log = entry => appendFile(join(process.env.PILOT_FIXTURE_DIR, 'events'), entry + '\n');

export async function authorize({ amount }) {
  await log('policy');
  if (amount !== '10000' || process.env.BUYER_DECLINES) return null;
  return { address: process.env.OTHER_PILOT_WALLET ? '0x' + '2'.repeat(40) : payer, signTypedData: async typed => {
    assert.equal(BigInt(typed.domain.chainId), 84532n);
    assert.equal(BigInt(typed.message.value), 10000n);
    await log('mock-sign');
    return '0x' + '11'.repeat(65);
  }};
}

globalThis.fetch = async (resource, init) => {
  assert.equal(resource, url);
  const signature = new Headers(init.headers).get('payment-signature');
  if (!signature) {
    await log('quote');
    const terms = { x402Version: 2, resource: { url }, accepts: [{ scheme: 'exact', network, asset,
      payTo: recipient, amount: '10000', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] };
    return Response.json(terms, { status: 402, headers: {
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(terms)).toString('base64') } });
  }
  const { job, request_key } = JSON.parse(init.body);
  const fingerprint = createHash('sha256').update(signature).digest('hex');
  await log('submit-' + fingerprint);
  if (process.env.LOSE_REPLY) return new Response(null, { status: 502 });
  const tx = '0x' + fingerprint;
  const changed = job.source.data[0].price !== job.target.data[0].price;
  const issues = changed ? [{ code: 'changed_value' }] : [];
  const report = { status: changed ? 'issues_found' : 'passed', issues, issue_count: issues.length,
    issues_truncated: false, summary: { source_rows: 1, target_rows: 1, matched_rows: 1, checked_values: 2 } };
  const quote_id = 'q_' + createHash('sha256').update('botsnacks-public-test-v1:' + request_key).digest('hex');
  return Response.json({ paid: true, test_funds: true, report, receipt: { mode: 'testnet', test_funds: true,
    quote_id, input_hash: catalogHash(job), report_hash: catalogHash(report), amount: '0.01', currency: 'USDC',
    network, payer, transaction: tx, settlement: { success: true, network, payer, transaction: tx, amount: '10000' } } });
};
