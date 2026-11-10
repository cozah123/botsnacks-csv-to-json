import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createInMemoryPaymentStorage,
  createPaymentTracker,
  createRateLimiter,
  decodePaymentRequiredHeader,
  evaluatePolicyGroups,
} from '@lucid-agents/payments';

const endpoint = 'https://botsnacks-testnet-api.cozah.chatgpt.site/api/v1/verify-transform';
const network = 'eip155:84532';
const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const recipient = '0x90b363b82bbffc5552d6635c8af959348117a7f3';
const job = {
  source: { format: 'csv', data: 'order_id,total\nA,12.00\nB,7.00\n' },
  target: { format: 'json', data: [{ order_id: 'A', total: '10.00' }] },
  key: { source: 'order_id', target: 'order_id' },
  fields: [{ source: 'total', target: 'total', type: 'decimal' }],
};

async function readQuote() {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'BotSnacks-Lucid-Quote/1.0',
    },
    body: JSON.stringify({ job, request_key: 'bs_qa_' + randomBytes(32).toString('base64url') }),
  });
  assert.equal(response.status, 402, 'Expected an unsigned payment challenge');
  const terms = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
  assert.ok(terms && isDeepStrictEqual(terms, await response.json()), 'Quote header and body must match');
  assert.equal(terms.x402Version, 2);
  assert.equal(terms.resource?.url, endpoint);
  assert.ok(Array.isArray(terms.accepts) && terms.accepts.length === 1, 'Expected one payment option');
  const [offer] = terms.accepts;
  assert.equal(offer.scheme, 'exact');
  assert.equal(offer.network, network);
  assert.equal(offer.asset?.toLowerCase(), usdc);
  assert.equal(offer.payTo?.toLowerCase(), recipient);
  assert.equal(offer.amount, '10000', 'Expected exactly 0.01 test USDC for this sample');

  const policy = [{
    name: 'botsnacks-two-orders',
    allowedRecipients: [recipient],
    outgoingLimits: { global: { maxPaymentUsd: 0.01, maxTotalUsd: 0.01, windowMs: 86400000 } },
  }];
  const decision = await evaluatePolicyGroups(
    policy, createPaymentTracker(createInMemoryPaymentStorage()), createRateLimiter(),
    endpoint, endpoint, BigInt(offer.amount), offer.payTo, new URL(endpoint).hostname,
  );
  assert.ok(decision.allowed, 'Lucid policy declined this quote');
  console.log(JSON.stringify({ status: 'quoted', network, price_test_usdc: '0.01', signed: false, charged: false }));
}

readQuote().catch(error => {
  console.error('BotSnacks quote failed:', error.message);
  process.exitCode = 1;
});
