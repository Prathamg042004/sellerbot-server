const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function load(env = {}, axiosMock = {}) {
  const routes = new Map();
  const app = {disable(){},use(){},get(path,fn){routes.set('GET '+path,fn);},post(path,fn){routes.set('POST '+path,fn);},patch(path,fn){routes.set('PATCH '+path,fn);},listen(){throw Error('Tests must not start a server');}};
  const express = () => app; express.json = () => () => {};
  const module = {exports:{}};
  const requireMock = name => {
    if(name === 'express') return express;
    if(name === 'crypto') return crypto;
    if(name === '@supabase/supabase-js') return {createClient:()=>({from(){throw Error('Unexpected database access');}})};
    if(name === '@anthropic-ai/sdk') return class {};
    if(name === 'axios') return axiosMock;
    if(name === './portal') return {mountPortal(){}};
    throw Error('Unexpected dependency '+name);
  };
  vm.runInNewContext(fs.readFileSync(__dirname+'/server.js','utf8'), {require:requireMock,module,exports:module.exports,process:{env},Buffer,console:{log(){},error(){}},setTimeout,Date});
  return {...module.exports,routes};
}
function response() {
  return {code:200,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;},send(body){this.body=body;return this;},sendStatus(code){this.code=code;return this;},set(){return this;}};
}
test('management API fails closed with missing or short configuration',()=>{
  for(const token of ['', 'short']) {
    const api=load({ADMIN_API_TOKEN:token});const res=response();
    api.requireAdmin({headers:{}},res,()=>assert.fail('must not authorize'));
    assert.equal(res.code,503);
  }
});
test('management API requires the exact server-operator bearer token',()=>{
  const token='test-admin-'.repeat(4);const api=load({ADMIN_API_TOKEN:token});
  for(const supplied of ['', 'Bearer wrong', 'Bearer '+token+'x']) {
    const res=response();api.requireAdmin({headers:{authorization:supplied}},res,()=>assert.fail('must not authorize'));assert.equal(res.code,401);
  }
  let allowed=false;api.requireAdmin({headers:{authorization:'Bearer '+token}},response(),()=>{allowed=true;});assert.equal(allowed,true);
});
test('webhook rejects missing configuration and invalid or modified signatures',()=>{
  const body=Buffer.from('{"object":"unsupported"}');
  const missing=load();const res=response();missing.routes.get('POST /webhook')({body:{},headers:{},rawBody:body},res);assert.equal(res.code,503);
  const secret='test-only-meta-secret';const api=load({APP_SECRET:secret});
  const signature='sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex');
  assert.equal(api.validWebhookSignature(body,signature),true);
  assert.equal(api.validWebhookSignature(Buffer.from('changed'),signature),false);
  assert.equal(api.validWebhookSignature(body,undefined),false);
  assert.equal(api.validWebhookSignature(body,'sha256=é'.repeat(64)),false);
  const rejected=response();api.routes.get('POST /webhook')({body:{},headers:{},rawBody:body},rejected);assert.equal(rejected.code,403);
});
test('webhook verification has no publicly known fallback token',()=>{
  const res=response();load().routes.get('GET /webhook')({query:{'hub.mode':'subscribe','hub.verify_token':'instasell_verify_2024'}},res);assert.equal(res.code,503);
});
test('order updates reject mass-assignment fields before database access',async()=>{
  const api=load();const res=response();
  await api.routes.get('PATCH /api/orders/:orderId')({body:{status:'paid',agreed_price:1,seller_id:'other'},params:{orderId:'demo'}},res);
  assert.equal(res.code,400);
});

// Product and application names must not accidentally trigger human handoff.
test('human handoff recognizes complete phrases without matching SellerBot or bestsellers',()=>{
 const api=load();
 for(const text of ['Connection test after authorizing SellerBot: what is the price?', 'Show your bestseller kurtas', 'Is this a humanmade pattern?', 'ownership details']) assert.equal(api.hasHumanRequest(text),false,text);
 for(const text of ['Can I speak to the seller?', 'A real person please', 'HUMAN', 'Talk to someone', 'Please contact the owner.']) assert.equal(api.hasHumanRequest(text),true,text);
});

test('photo delivery counts only accepted images and reports failures honestly',async()=>{
 let calls=0;const api=load({}, {post:async()=>{calls++;if(calls===2)throw Error('synthetic delivery failure');return {data:{message_id:'synthetic-mid'}};}});
 const products=[{sku:'A',name:'Demo A',listed_price:100,image_url:'https://example.com/a.jpg'},{sku:'B',name:'Demo B',listed_price:200,image_url:'https://example.com/b.jpg'},{sku:'C',name:'Demo C',listed_price:300}];
 const r=await api.sendProductPhotos('shop','buyer',['A','A','B','C','unknown',''],products,'synthetic-token');
 assert.equal(calls,2);assert.equal(r.sent.join(','),'A');assert.equal(r.failed.join(','),'B');assert.equal(r.unavailable.join(','),'Demo C,unknown');
 assert.match(api.photoDeliverySummary(r),/Sent 1 illustrative demo image/);assert.match(api.photoDeliverySummary(r),/Some requested images/);
 const noConfirmation=load({}, {post:async()=>({data:{}})});const failed=await noConfirmation.sendProductPhotos('shop','buyer',['A'],products,'synthetic-token');assert.equal(failed.sent.length,0);assert.match(noConfirmation.photoDeliverySummary(failed),/could not be delivered/);
});
