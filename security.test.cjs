const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function load(env = {}, axiosMock = {}, dbMock) {
  const routes = new Map();
  const app = {disable(){},use(){},get(path,fn){routes.set('GET '+path,fn);},post(path,fn){routes.set('POST '+path,fn);},patch(path,fn){routes.set('PATCH '+path,fn);},listen(){throw Error('Tests must not start a server');}};
  const express = () => app; express.json = () => () => {};
  const module = {exports:{}};
  const requireMock = name => {
    if(name === 'express') return express;
    if(name === 'crypto') return crypto;
    if(name === '@supabase/supabase-js') return {createClient:()=>(dbMock||{from(){throw Error('Unexpected database access');}})};
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

test('handoff remains paused on subsequent messages and stores incoming text without AI or sends',async()=>{
 const calls=[];const db={from(table){const q={select(){return q},eq(){return q},order(){return q},limit(){return q},in(k,values){assert.ok(values.includes('human_handoff'));return q},insert(value){calls.push({table,value});return q},update(){return q},single(){return q},maybeSingle(){return q},then(resolve){if(table==='sellers')resolve({data:{id:'seller',is_active:true,page_access_token:'synthetic'}});else if(table==='buyers')resolve({data:{id:'buyer'}});else if(table==='conversations')resolve({data:{id:'conv',status:'human_handoff'}});else if(table==='messages')resolve({error:null});else assert.fail('Paused conversation must not read '+table);}};return q;}};
 const api=load({}, {post:()=>assert.fail('No messages should be sent')},db);
 await api.handleIncomingDM({sender:{id:'buyer-ig'},recipient:{id:'seller-ig'},message:{mid:'msg-1',text:'notify me about the shirt'}});
 assert.equal(calls.length,1);assert.equal(calls[0].table,'messages');assert.equal(calls[0].value.conversation_id,'conv');
});

function incomingFixture({insertError=null, pauseError=null}={}) {
 const seen=new Set(), writes=[], sends=[];
 const db={from(table){let operation='select',value;const q={select(){return q},eq(){return q},order(){return q},limit(){return q},in(){return q},single(){return q},maybeSingle(){return q},insert(v){operation='insert';value=v;return q},update(v){operation='update';value=v;return q},then(resolve){
  if(operation==='update'){writes.push({table,value});return resolve({error:table==='conversations'&&value.status==='human_handoff'?pauseError:null});}
  if(table==='messages') {writes.push({table,value});const duplicate=seen.has(value.instagram_mid);seen.add(value.instagram_mid);return resolve({error:insertError||(duplicate?{code:'23505'}:null)});}
  resolve({data:table==='sellers'?{id:'seller',is_active:true,page_access_token:'synthetic'}:table==='buyers'?{id:'buyer'}:{id:'conv',status:'human_handoff'}});
 }};return q;}};
 const api=load({}, {post:async(...args)=>{sends.push(args);return {data:{message_id:'sent'}};}},db);
 const event={sender:{id:'buyer-ig'},recipient:{id:'seller-ig'},message:{mid:'unique-mid',text:'Please contact the owner'}};
 return {api,event,writes,sends};
}
test('concurrent duplicate handoff deliveries send only one acknowledgement',async()=>{
 const f=incomingFixture();await Promise.all([f.api.handleIncomingDM(f.event),f.api.handleIncomingDM(f.event)]);
 assert.equal(f.sends.length,1);
 assert.equal(f.writes.filter(w=>w.value.status==='human_handoff').length,1);
 assert.ok(f.writes.some(w=>w.table==='messages'&&w.value.content==='Please contact the owner'));
});
test('message persistence failures stop all replies and downstream actions',async()=>{
 const f=incomingFixture({insertError:{code:'08006'}});
 await assert.rejects(f.api.handleIncomingDM(f.event),/Could not save incoming message/);
 assert.equal(f.sends.length,0);assert.equal(f.writes.length,1);
});
test('handoff persistence failure never falsely tells the customer AI is paused',async()=>{
 const f=incomingFixture({pauseError:{code:'08006'}});
 await assert.rejects(f.api.handleIncomingDM(f.event),/Could not pause/);assert.equal(f.sends.length,0);
});
test('missing provider message IDs are ignored before database or network access',async()=>{
 const api=load();await api.handleIncomingDM({sender:{id:'b'},recipient:{id:'s'},message:{text:'hi'}});await api.handleIncomingDM({});
});
test('duplicate opt-out deliveries do not send repeated confirmations',async()=>{
 const f=incomingFixture();f.event.message.text='unsubscribe';
 await f.api.handleIncomingDM(f.event);await f.api.handleIncomingDM(f.event);
 assert.equal(f.sends.length,1);assert.equal(f.writes.filter(w=>w.table==='buyers'&&w.value.is_opted_out).length,1);
});

test('takeover brief shows newest buyer message and matching orders with escaped customer content',()=>{
 const source=fs.readFileSync(__dirname+'/public/workspace.js','utf8');
 const helper=source.slice(source.indexOf('function handoffBrief('),source.indexOf('async function conversation('));
 const context={data:{orders:[{buyer_id:'other',product_name:'PRIVATE'},{buyer_id:'buyer',order_number:7,product_name:'<script>bad</script>',status:'paid',created_at:'2026-10-01',tracking_number:'ABC'}]},esc:v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;'),pill:v=>v};
 vm.createContext(context);vm.runInContext(helper,context);
 const html=context.handoffBrief({buyer_id:'buyer'},[{role:'buyer',content:'Old question',created_at:'2026-10-01'},{role:'buyer',content:'<img src=x>Latest question',created_at:'2026-10-02'},{role:'assistant',content:'Assistant answer',created_at:'2026-10-03'}]);
 assert.match(html,/Latest question/);assert.match(html,/ABC/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/PRIVATE|Old question|Assistant answer|<img|<script>/);
});
