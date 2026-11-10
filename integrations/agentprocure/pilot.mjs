import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, parseEventLogs } from 'viem';
import { baseSepolia } from 'viem/chains';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { discoverServices, rankEndpointsByRelevance } from './upstream/discovery.ts';
import { createBudgetPlan } from './upstream/budget.ts';

const origin = 'https://botsnacks-testnet-api.cozah.chatgpt.site';
const path = '/api/v1/verify-transform';
const endpoint = origin + path;
const network = 'eip155:84532';
const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const receiver = '0x90b363b82bbffc5552d6635c8af959348117a7f3';
const ownerTestWallet = '0xb94728989c09df2cae8377f83ad03d4773087c38';
const job = {
  source: {format: 'csv', data: 'order_id,total\nA,12.00\nB,7.00\n'},
  target: {format: 'json', data: [{order_id: 'A', total: '10.00'}]},
  key: {source: 'order_id', target: 'order_id'},
  fields: [{source: 'total', target: 'total', type: 'decimal'}],
};

const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'botsnacks', 'agentprocure-two-orders-v1');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const sha = text => createHash('sha256').update(text).digest('hex');
const makeBody = () => JSON.stringify({job, request_key: randomBytes(32).toString('base64url')});

async function plan() {
  const catalog = await discoverServices([origin]);
  const ranked = rankEndpointsByRelevance(catalog, 'Check my CSV conversion for missing orders and changed totals');
  const {plannedCalls} = createBudgetPlan(ranked, 0.01);
  const [call] = plannedCalls;
  check(plannedCalls.length === 1 && call.service.baseUrl === origin &&
    call.service.service === 'botsnacks' && call.service.testnet_only === true &&
    call.service.network === network && call.endpoint.path === path &&
    call.endpoint.method === 'POST' && call.estimatedCost === 0.01, 'No eligible BotSnacks route in the 0.01 plan.');
}

async function post(body, signature) {
  return fetch(endpoint, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: {'Content-Type': 'application/json', 'User-Agent': 'AgentProcure-BotSnacks-Pilot/1.0',
      ...(signature ? {'PAYMENT-SIGNATURE': signature} : {})}, body});
}

async function quote(body) {
  await plan();
  const response = await post(body);
  check(response.status === 402, 'Expected a job quote. HTTP ' + response.status);
  const terms = await response.json();
  const header = response.headers.get('PAYMENT-REQUIRED');
  check(header && canonical(JSON.parse(Buffer.from(header, 'base64').toString())) === canonical(terms),
    'Quote header and body disagree.');
  const offer = terms.accepts?.[0];
  const expectedExtra = {name: 'USDC', version: '2', assetTransferMethod: 'eip3009', paymentFlow: 'authorization'};
  check(terms.x402Version === 2 && terms.resource?.url === endpoint && terms.accepts?.length === 1 &&
    offer?.scheme === 'exact' && offer.network === network && offer.amount === '10000' &&
    offer.asset?.toLowerCase() === usdc && offer.payTo?.toLowerCase() === receiver &&
    offer.maxTimeoutSeconds === 60 && canonical(offer.extra) === canonical(expectedExtra), 'Quote violates the fixed testnet pilot policy.');
  // Only these allowlisted terms reach the signer. Discovery extensions are not wallet instructions.
  return {x402Version: 2, resource: {url: endpoint, mimeType: 'application/json', description: 'Two-order test'},
    accepts: [{scheme: 'exact', network, amount: '10000', asset: offer.asset, payTo: offer.payTo,
      maxTimeoutSeconds: 60, extra: expectedExtra}]};
}

async function readSaved(directory) {
  try { return JSON.parse(await readFile(join(directory,'authorization.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function syncDirectory(directory) {
  const dir = await open(directory, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

async function authorizeOnce(directory, body, terms, signer) {
  const payer = signer.address.toLowerCase();
  check(/^0x[0-9a-f]{40}$/.test(payer) && payer !== ownerTestWallet && payer !== receiver,
    'The pilot requires an independent buyer wallet.');
  await mkdir(directory, {recursive: true, mode: 0o700});
  // This marker is permanent. A crash before the durable authorization requires reconciliation.
  const marker = await open(join(directory,'signing'), 'wx', 0o600).catch(e => {
    if (e.code === 'EEXIST') throw new Error('Signing was already started. Use recover with the same state directory.');
    throw e;
  });
  await marker.close();
  await syncDirectory(directory);
  const client = new x402Client();
  registerExactEvmScheme(client, {signer, networks: [network]});
  const payload = await client.createPaymentPayload(terms);
  const signature = new x402HTTPClient(client).encodePaymentSignatureHeader(payload)['PAYMENT-SIGNATURE'];
  check(signature && payload.payload?.authorization?.from?.toLowerCase() === payer, 'No matching wallet authorization.');
  const saved = {body, payer, signature};
  const tmp = join(directory,'authorization.tmp');
  const f = await open(tmp,'wx',0o600);
  try { await f.writeFile(JSON.stringify(saved)); await f.sync(); } finally { await f.close(); }
  await rename(tmp, join(directory,'authorization.json'));
  await syncDirectory(directory);
  return saved;
}

function validateSaved(saved) {
  const request = JSON.parse(saved.body);
  const payment = JSON.parse(Buffer.from(saved.signature, 'base64').toString());
  const accepted = payment.accepted;
  const authorization = payment.payload?.authorization;
  check(Object.keys(request).length === 2 && canonical(request.job) === canonical(job) &&
    /^[A-Za-z0-9_-]{43}$/.test(request.request_key) && /^0x[0-9a-f]{40}$/.test(saved.payer) &&
    saved.payer !== receiver && saved.payer !== ownerTestWallet && payment.x402Version === 2 &&
    payment.resource?.url === endpoint && accepted?.network === network && accepted.scheme === 'exact' &&
    accepted.payTo?.toLowerCase() === receiver && accepted.asset?.toLowerCase() === usdc &&
    accepted.amount === '10000' && authorization?.from?.toLowerCase() === saved.payer &&
    authorization.to?.toLowerCase() === receiver && authorization.value === accepted.amount,
    'Saved authorization does not match the pilot. Keep the original state for reconciliation.');
}

async function delivery(saved) {
  const response = await post(saved.body, saved.signature);
  check(response.status === 200, 'Checkout returned HTTP ' + response.status + '. Reconcile using recover in the same state directory.');
  const data = await response.json();
  const {receipt, report} = data;
  check(data.paid === true && data.test_funds === true && data.mode === 'testnet' &&
    typeof data.charged_this_request === 'boolean' && receipt?.mode === 'testnet' && receipt.test_funds === true &&
    receipt.network === network && receipt.currency === 'USDC' && receipt.amount === '0.01' &&
    receipt.payer?.toLowerCase() === saved.payer && receipt.quote_id === data.quote_id &&
    receipt.quote_id === 'q_' + sha('botsnacks-public-test-v1:' + JSON.parse(saved.body).request_key) &&
    receipt.settlement?.success === true && receipt.settlement.network === network &&
    receipt.settlement.payer?.toLowerCase() === saved.payer && receipt.transaction === receipt.settlement.transaction &&
    /^0x[0-9a-f]{64}$/i.test(receipt.transaction) && receipt.input_hash === sha(canonical(job)) &&
    report && receipt.report_hash === sha(canonical(report)), 'Receipt or report validation failed.');
  check(report.status === 'issues_found' && report.issue_count === 2 && report.issues.length === 2 &&
    report.issues.some(i => i.code === 'missing_record' && i.key === 'B') &&
    report.issues.some(i => i.code === 'changed_value' && i.key === 'A' && i.source_field === 'total' &&
      i.target_field === 'total' && i.source_value === '12.00' && i.target_value === '10.00'),
    'The comparison did not return the two expected findings.');
  return data;
}

const transfer = [{type:'event', name:'Transfer', inputs:[
  {type:'address',name:'from',indexed:true}, {type:'address',name:'to',indexed:true}, {type:'uint256',name:'value',indexed:false}]}];

async function verifyTransfer(receipt) {
  const chain = createPublicClient({chain:baseSepolia, transport:http()});
  check(await chain.getChainId() === 84532, 'Unexpected receipt network.');
  const tx = await chain.getTransactionReceipt({hash:receipt.transaction});
  const logs = parseEventLogs({abi:transfer, logs:tx.logs.filter(l => l.address.toLowerCase() === usdc)});
  const sent = logs.filter(l => l.args.from.toLowerCase() === receipt.payer.toLowerCase());
  check(tx.status === 'success' && tx.transactionHash.toLowerCase() === receipt.transaction.toLowerCase() &&
    sent.length === 1 && sent[0].args.to.toLowerCase() === receiver && sent[0].args.value === 10000n,
    'Expected one 0.01 USDC transfer from the buyer to BotSnacks.');
}

export async function runPilot(action, {directory = stateDir, getSigner} = {}) {
  check(['quote','purchase','recover'].includes(action), 'Choose quote, purchase, or recover.');
  if (action === 'quote') {
    await quote(makeBody());
    return {status:'quoted', network, test_usdc:'0.01', signed:false};
  }
  let saved = await readSaved(directory);
  if (!saved) {
    check(action === 'purchase', 'No saved authorization. If signing was interrupted, reconcile the original attempt.');
    const body = makeBody();
    const terms = await quote(body);
    saved = await authorizeOnce(directory, body, terms, await getSigner());
  }
  validateSaved(saved);
  const first = await delivery(saved);
  const repeat = await delivery(saved);
  check(repeat.charged_this_request === false, 'Seller did not confirm a free repeat retrieval.');
  assert.deepEqual(repeat.receipt, first.receipt, 'Recovered receipt changed.');
  assert.deepEqual(repeat.report, first.report, 'Recovered report changed.');
  await verifyTransfer(first.receipt);
  return {status:'verified', network, test_usdc:'0.01', payer:saved.payer,
    quote_id:first.quote_id, transaction:first.receipt.transaction, report_hash:first.receipt.report_hash,
    repeat_charged:false, report:first.report, receipt:first.receipt};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] ?? 'quote';
  const getSigner = async () => {
    check(/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY ?? ''), 'Configure your existing buyer signer before opting in.');
    const {privateKeyToAccount} = await import('viem/accounts');
    return privateKeyToAccount(process.env.PRIVATE_KEY);
  };
  try { console.log(JSON.stringify(await runPilot(action, {getSigner}))); }
  catch (error) {
    // SDK/RPC error objects can contain the signed request. Only expose our known messages.
    const safe = ['No eligible','Expected a job quote','Quote header','Quote violates','The pilot requires','Signing was',
      'No matching','Checkout returned','Receipt or','The comparison','Unexpected receipt','Expected one','Choose quote',
      'No saved authorization','Saved authorization','Seller did','Recovered receipt','Recovered report','Configure your existing'];
    console.error(safe.some(prefix => error.message?.startsWith(prefix)) ? error.message.split('\n')[0] :
      'Pilot could not complete. Keep the same state directory and reconcile any signed attempt with recover.');
    process.exitCode = 1;
  }
}
