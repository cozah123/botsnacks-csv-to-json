import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem';
import { runPilot } from './pilot.mjs';

const url = 'https://botsnacks-testnet-api.cozah.chatgpt.site/api/v1/verify-transform';
const network = 'eip155:84532';
const payer = '0x1111111111111111111111111111111111111111';
const recipient = '0x90b363b82bbffc5552d6635c8af959348117a7f3';
const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const txHash = '0x' + 'ab'.repeat(32);
const offer = {scheme:'exact', network, amount:'10000', asset:token, payTo:recipient, maxTimeoutSeconds:60,
  extra:{name:'USDC',version:'2',assetTransferMethod:'eip3009',paymentFlow:'authorization'}};
const hash = s => createHash('sha256').update(s).digest('hex');
function sorted(x) {
  if (Array.isArray(x)) return x.map(sorted);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])]));
  return x;
}

test('fixed purchase, lost reply, original authorization replay and on-chain receipt checks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'botsnacks-pilot-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  let price = '10000', signs = 0, signedCalls = 0, replayCharged = false, transferred = 10000n;
  let firstProof, firstBody;
  const report = {status:'issues_found', issue_count:2, issues:[{code:'missing_record',key:'B'},
    {code:'changed_value',key:'A',source_field:'total',target_field:'total',source_value:'12.00',target_value:'10.00'}]};
  t.mock.method(globalThis, 'fetch', async (resource, init = {}) => {
    const target = String(resource);
    if (target.endsWith('/api/discover')) return Response.json({service:'botsnacks',name:'BotSnacks',
      description:'Check CSV conversion',network,testnet_only:true,
      endpoints:[{method:'POST',path:'/api/v1/verify-transform',description:'Order comparison',price:'$0.01',params:{}}]});
    if (target === url) {
      const body = JSON.parse(init.body);
      assert.equal(body.job.target.data[0].total, '10.00');
      const sig = new Headers(init.headers).get('payment-signature');
      if (!sig) {
        const terms = {x402Version:2,resource:{url},accepts:[{...offer,amount:price}]};
        return Response.json(terms,{status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(terms)).toString('base64')}});
      }
      signedCalls++;
      const payment = JSON.parse(Buffer.from(sig,'base64').toString());
      assert.deepEqual(payment.accepted, offer);
      assert.equal(payment.payload.authorization.from.toLowerCase(), payer);
      assert.equal(payment.payload.authorization.value, '10000');
      if (signedCalls === 1) {
        firstProof = sig; firstBody = init.body;
        return new Response(null,{status:502});
      }
      assert.equal(sig,firstProof);
      assert.equal(init.body,firstBody);
      const quote_id = 'q_' + hash('botsnacks-public-test-v1:' + body.request_key);
      return Response.json({mode:'testnet',paid:true,test_funds:true,charged_this_request:replayCharged,quote_id,report,
        receipt:{mode:'testnet',test_funds:true,network,payer,amount:'0.01',currency:'USDC',quote_id,transaction:txHash,
          input_hash:hash(JSON.stringify(sorted(body.job))),report_hash:hash(JSON.stringify(sorted(report))),
          settlement:{success:true,network,payer,transaction:txHash}}});
    }
    const rpc = JSON.parse(init.body);
    let result;
    if (rpc.method === 'eth_chainId') result = '0x14a34';
    else {
      assert.equal(rpc.method, 'eth_getTransactionReceipt');
      assert.equal(rpc.params[0], txHash);
      const topics = encodeEventTopics({abi:parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
        eventName:'Transfer',args:{from:payer,to:recipient}});
      result = {transactionHash:txHash,status:'0x1',logs:[{address:token,topics,
        data:encodeAbiParameters([{type:'uint256'}],[transferred])}]};
    }
    return Response.json({jsonrpc:'2.0',id:rpc.id,result});
  });
  const getSigner = async () => ({address:payer,signTypedData:async typed => {
    signs++;
    assert.equal(Number(typed.domain.chainId),84532);
    assert.equal(typed.domain.verifyingContract.toLowerCase(),token.toLowerCase());
    assert.equal(typed.message.to.toLowerCase(),recipient);
    assert.equal(BigInt(typed.message.value),10000n);
    return '0x' + '11'.repeat(65); // A dummy byte string used only in this offline transport.
  }});
  const neverSign = () => assert.fail('Unexpected signer access.');
  assert.equal((await runPilot('quote',{directory,getSigner:neverSign})).signed,false);
  price = '30000';
  await assert.rejects(runPilot('purchase',{directory,getSigner:neverSign}), /fixed testnet pilot policy/);
  price = '10000';
  await assert.rejects(runPilot('purchase',{directory,getSigner}), /HTTP 502/);
  const result = await runPilot('recover',{directory,getSigner:neverSign});
  assert.equal(result.transaction,txHash);
  assert.equal(result.repeat_charged,false);
  await runPilot('purchase',{directory,getSigner:neverSign});
  assert.equal(signs,1);
  replayCharged = true;
  await assert.rejects(runPilot('recover',{directory}), /free repeat retrieval/);
  replayCharged = false;
  transferred = 20000n;
  await assert.rejects(runPilot('recover',{directory}), /one 0.01 USDC transfer/);
});
