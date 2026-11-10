import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

const endpoint = 'https://botsnacks-testnet-api.cozah.chatgpt.site/api/v1/verify-transform';
const network = 'eip155:84532';
const receiver = '0x90b363b82bbffc5552d6635c8af959348117a7f3';
const token = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const fields = new Set(['start_time', 'venue', 'ticket_url']);
const hash = text => createHash('sha256').update(text).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

function validJob(job) {
  if (!job || job.key?.source !== 'event_id' || job.key?.target !== 'event_id' ||
      !Array.isArray(job.fields) || !job.fields.length || job.fields.length > fields.size) return false;
  const selected = job.fields.map(f => f?.source);
  if (new Set(selected).size !== selected.length ||
      !job.fields.every(f => fields.has(f?.source) && f.target === f.source && f.type === 'exact')) return false;
  const allowed = new Set(['event_id', ...selected]);
  return Object.keys(job).every(k => ['source','target','key','fields'].includes(k)) &&
    [job.source,job.target].every(side => side?.format === 'json' && Array.isArray(side.data) &&
      side.data.length <= 5000 && side.data.every(row => row && typeof row.event_id === 'string' &&
        row.event_id.trim() && Object.keys(row).every(k => allowed.has(k) && typeof row[k] === 'string'))) &&
    job.source.data.length > 0;
}

async function existing(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}

// Publish only complete records. Concurrent workers share the first durable value.
async function saveOnce(path, value) {
  const tmp = path + '.' + randomUUID();
  const file = await open(tmp, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    try { await link(tmp, path); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const dir = await open(dirname(path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return await existing(path);
  } finally { await unlink(tmp); }
}

async function post(body, signature) {
  return fetch(endpoint, {method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
    headers:{'Content-Type':'application/json', 'User-Agent':'BotSnacksScheduleBuyer/1.0',
      ...(signature ? {'PAYMENT-SIGNATURE':signature} : {})}, body});
}

const prices = new Map([['10000','0.01'], ['30000','0.03'], ['50000','0.05']]);

async function readOffer(response) {
  if (response.status !== 402) throw Error('Expected an eligible job quote.');
  const client = new x402Client();
  const http = new x402HTTPClient(client);
  const terms = http.getPaymentRequiredResponse(k => response.headers.get(k), await response.json());
  const offer = terms.accepts?.[0];
  if (terms.x402Version !== 2 || terms.resource?.url !== endpoint || terms.accepts?.length !== 1 ||
      offer?.scheme !== 'exact' || offer.network !== network || !prices.has(offer.amount) ||
      offer.asset?.toLowerCase() !== token || offer.payTo?.toLowerCase() !== receiver ||
      (offer.extra?.assetTransferMethod !== undefined && offer.extra.assetTransferMethod !== 'eip3009') ||
      offer.extra?.name !== 'USDC' || offer.extra?.version !== '2' ||
      !Number.isInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds <= 0 || offer.maxTimeoutSeconds > 300)
    throw Error('Unexpected payment terms.');
  return {client,http,terms,amount:prices.get(offer.amount)};
}

async function sign(body, signer) {
  const {client,http,terms,amount} = await readOffer(await post(body));
  if (BigInt(terms.accepts[0].amount) > 30000n) throw Error('Quote exceeds the authorized schedule budget.');
  registerExactEvmScheme(client, {signer, networks:[network]});
  const payload = await client.createPaymentPayload(terms);
  const signature = http.encodePaymentSignatureHeader(payload)['PAYMENT-SIGNATURE'];
  if (!signature) throw Error('No authorization returned.');
  return {signature,amount};
}

// Optional EIP-191 identification is separate from payment authorization.
async function freeQuote(request, quoteSigner) {
  let body = request.body;
  if (quoteSigner) {
    const input = JSON.parse(body);
    const address = quoteSigner.address.toLowerCase();
    const expires = Math.floor(Date.now()/1000) + 240;
    const id = 'q_' + hash('botsnacks-public-test-v1:' + input.request_key);
    const message = [
      'BotSnacks free schedule quote identification',
      'Service: ' + endpoint, 'Network: ' + network, 'Wallet: ' + address,
      'Request: ' + id, 'Schedule digest: ' + request.jobHash,
      'Expires (Unix seconds): ' + expires,
      'This identifies a quote request only. No payment or spending permission.',
    ].join('\n');
    const signature = await quoteSigner.signMessage({message});
    body = JSON.stringify({...input,quote_proof:{address,expires,signature}});
    if (Buffer.byteLength(body) > 1000000) throw Error('Quote proof exceeds the request limit.');
  }
  let response = await post(body);
  // A server without optional proof support may still provide the free quote.
  if (quoteSigner && response.status === 422) response = await post(request.body);
  return (await readOffer(response)).amount;
}

function validateResult(result, jobHash, payer, amount) {
  const r = result?.receipt;
  if (result?.mode !== 'testnet' || result?.test_funds !== true || result.paid !== true ||
      !['passed','issues_found','cannot_verify'].includes(result.report?.status) ||
      r?.protocol !== 'x402' || r.mode !== 'testnet' || r.test_funds !== true ||
      r.network !== network || !['0.01','0.03'].includes(amount) || r.amount !== amount || r.currency !== 'USDC' ||
      r.payer?.toLowerCase() !== payer || !result.quote_id || r.quote_id !== result.quote_id ||
      r.input_hash !== jobHash || r.report_hash !== hash(canonical(result.report)) ||
      !/^0x[0-9a-f]{64}$/i.test(r.transaction) || r.settlement?.success !== true ||
      r.transaction !== r.settlement.transaction) throw Error('Settlement or report could not be confirmed.');
}

// Mount behind the buyer's existing authenticated scheduler route. Policy is buyer-owned.
// authorize must authorize this principal to read this batch and, for a purchase,
// approve sharing the exact job and one payment up to 0.03 test USDC using its signer.
export function scheduleCheckout({directory, authorize}) {
  if (!directory || typeof authorize !== 'function') throw Error('Private storage and buyer policy are required.');
  return async (req, res) => {
    const reply = (http, status, extra = {}) => res.status(http).set('Cache-Control','no-store')
      .json({status, ...extra});
    try {
      const {action, batch_id, job} = req.body ?? {};
      if (!['quote','purchase','retrieve'].includes(action) || typeof batch_id !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(batch_id) || !validJob(job))
        return reply(422,'invalid_batch');
      const grant = await authorize(req, {action, batch_id, job, network, recipient:receiver, amount:action==='quote'?'0':'0.03'});
      if (typeof grant?.scope !== 'string' || !grant.scope || (action === 'quote' && grant.allowQuote !== true) ||
          (action === 'purchase' && !/^0x[0-9a-f]{40}$/i.test(grant.signer?.address)))
        return reply(403,'buyer_policy_denied');
      const jobHash = hash(canonical(job));
      const folder = join(directory, hash(JSON.stringify([grant.scope,batch_id])));
      const requestFile = join(folder,'request.json');
      let request = await existing(requestFile);
      if (!request) {
        if (action === 'retrieve') return reply(404,'no_saved_purchase');
        const key = (grant.testRun === true ? 'bs_qa_' : '') + randomBytes(32).toString('base64url');
        const body = JSON.stringify({job, request_key:key});
        if (Buffer.byteLength(body) > 1000000) return reply(422,'invalid_batch');
        await mkdir(folder,{recursive:true,mode:0o700});
        request = await saveOnce(requestFile,{jobHash,body});
      }
      if (request.jobHash !== jobHash) return reply(409,'batch_revision_conflict');
      if (action === 'quote') {
        // The caller must separately approve sharing the data; no payment signer is used.
        const amount = await freeQuote(request,grant.quoteSigner);
        return reply(200,'schedule_quoted',{batch_id,network,amount,currency:'test USDC',charged:false});
      }
      // Older request files already hold the approved payer. New batches bind it on first purchase.
      const payerPath = join(folder,'payer.json');
      let payer = request.payer ?? await existing(payerPath);
      if (action === 'purchase') {
        const wallet = grant.signer.address.toLowerCase();
        payer ??= await saveOnce(payerPath,wallet);
        if (payer !== wallet) return reply(409,'batch_revision_conflict');
      }
      if (!payer) return reply(409,'no_saved_authorization');
      const resultFile = join(folder,'result.json');
      const proofFile = join(folder,'authorization.json');
      let result = await existing(resultFile);
      const fromCache = result !== null;
      if (!result) {
        let proof = await existing(proofFile);
        if (!proof) {
          if (action === 'retrieve') return reply(409,'no_saved_authorization');
          const lockFile = proofFile + '.signing';
          let lock;
          try { lock = await open(lockFile,'wx',0o600); }
          catch (e) { if (e.code !== 'EEXIST') throw e; return reply(202,'checkout_pending'); }
          try {
            proof = await existing(proofFile);
            if (!proof) proof = await saveOnce(proofFile,{digest:hash(request.body),...await sign(request.body,grant.signer)});
          } finally { await lock.close(); await unlink(lockFile); }
        }
        if (proof.digest !== hash(request.body) || !proof.signature) throw Error('Invalid saved authorization.');
        const paid = await post(request.body,proof.signature);
        if (paid.status !== 200) return reply(paid.status === 202 ? 202 : 502,'reconcile_original');
        const delivered = await paid.json();
        validateResult(delivered,jobHash,payer,proof.amount ?? '0.03');
        result = await saveOnce(resultFile,{quote_id:delivered.quote_id, mode:delivered.mode,
          amount:proof.amount ?? '0.03',test_funds:true,paid:true,report:delivered.report,receipt:delivered.receipt});
      }
      validateResult(result,jobHash,payer,result.amount ?? '0.03');
      return reply(200,'report_ready',{batch_id,source:fromCache?'saved_report':'seller',
        quote_id:result.quote_id, report:result.report, receipt:result.receipt});
    } catch { return reply(503,'hold_and_reconcile'); }
  };
}
