const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const express=require('express');
function app(env){
 const module={exports:{}};
 const dependencies={'./portal':{mountPortal(){}},express,crypto,'@supabase/supabase-js':{createClient:()=>({from(){throw Error('Unexpected database access');}})},'@anthropic-ai/sdk':class{},axios:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/server.js','utf8'),{module,exports:module.exports,require:name=>{if(name in dependencies)return dependencies[name];throw Error('Unexpected dependency');},process:{env},Buffer,console:{log(){},error(){}},setTimeout,Date});
 return module.exports.app;
}
test('real HTTP middleware rejects unauthenticated management requests and validates signed raw bodies',async()=>{
 const token='synthetic-test-token-'.repeat(3), secret='synthetic-meta-secret';
 const server=app({ADMIN_API_TOKEN:token,APP_SECRET:secret,VERIFY_TOKEN:'synthetic-verify'}).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try {
  for(const endpoint of ['/api/orders/seller','/api/products/seller','/api/categories/seller','/api/dashboard/seller','/api/buyer-activity/seller']) {
   const r=await fetch(base+endpoint);assert.equal(r.status,401);assert.equal(r.headers.get('x-powered-by'),null);
  }
  const patch=await fetch(base+'/api/orders/order',{method:'PATCH',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({status:'paid',seller_id:'other'})});
  assert.equal(patch.status,400);assert.equal(patch.headers.get('cache-control'),'no-store');
  const body=JSON.stringify({object:'unsupported'});
  const signature='sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex');
  const post=(payload,sig)=>fetch(base+'/webhook',{method:'POST',headers:{'content-type':'application/json',...(sig?{'x-hub-signature-256':sig}:{})},body:payload});
  assert.equal((await post(body)).status,403);
  assert.equal((await post(body,signature)).status,200);
  assert.equal((await post(body+' ',signature)).status,403);
  const oversized=await post(JSON.stringify({text:'x'.repeat(270000)}),signature);
  assert.equal(oversized.status,413);assert.deepEqual(await oversized.json(),{error:'Request body too large.'});
  const malformed=await post('{broken',signature);assert.equal(malformed.status,400);assert.deepEqual(await malformed.json(),{error:'Valid JSON required.'});
  assert.equal((await fetch(base+'/health')).status,200);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
