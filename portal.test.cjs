const test=require('node:test');const assert=require('node:assert/strict');const express=require('express');const {mountPortal}=require('./portal');
async function fixture(options={}) {
 const saved=[];let calls=0;let records=[];
 const db={from(table){let operation='read',values=null;const filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},update(v){operation='update';values=v;return q;},insert(v){operation='insert';values=v;return q;},maybeSingle:async()=>({data:{id:'seller-owned'},error:null}),single:async()=>{if(operation!=='read'){saved.push({table,values,filters});return {data:{id:'seller-owned'}};}return {data:{id:'seller-owned',instagram_username:'test_shop',is_active:true}};},then(resolve){saved.push({table,values,filters});resolve(table==='products'?{count:23}:{error:null});}};return q;}};
 const http={async post(url,body){calls++;records.push({url,body});if(url.includes('/oauth/'))return {data:{data:[{access_token:'synthetic-short',user_id:'42',permissions:options.partial?'instagram_business_basic':'instagram_business_basic,instagram_business_manage_messages'}]}};return {data:{success:!options.subscriptionFailure}};},async get(url){calls++;if(url.endsWith('/access_token'))return {data:{access_token:'synthetic-long',expires_in:5184000}};return {data:{user_id:'17841400000000000',username:'test_shop'}};}};
 const app=express();const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;let time=Date.now();
 mountPortal(app,{db,http,env:{PUBLIC_BASE_URL:base,APP_SECRET:'synthetic-app-secret',INSTAGRAM_APP_ID:'123'},now:()=>time});
 let cookie='';const request=async(url,opts={})=>{const r=await fetch(base+url,{redirect:'manual',...opts,headers:{cookie,...opts.headers}});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;};
 const status=async()=> (await request('/app/status')).json();
 const start=async()=>{const s=await status();const r=await request('/auth/instagram/start',{method:'POST',headers:{origin:base,'x-csrf-token':s.csrf}});return new URL((await r.json()).url);};
 const close=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));};
 return {request,status,start,close,base,saved,records,calls:()=>calls,advance:()=>time+=11*60000};
}
test('OAuth rejects missing, mismatched, expired and replayed state before token exchange',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('/auth/instagram/callback?code=x&state=forged')).headers.get('location'),'/app?notice=invalid_state');
  const url=await f.start();assert.equal(url.origin,'https://www.instagram.com');assert.equal(url.searchParams.get('scope'),'instagram_business_basic,instagram_business_manage_messages');
  assert.equal(url.searchParams.get('redirect_uri'),f.base+'/auth/instagram/callback');assert.equal(url.searchParams.get('client_secret'),null);
  f.advance();assert.equal((await f.request('/auth/instagram/callback?code=x&state='+url.searchParams.get('state'))).headers.get('location'),'/app?notice=invalid_state');assert.equal(f.calls(),0);
 }finally{await f.close();}
});
test('actual callback persists only the verified account, subscribes messages, and hides tokens',async()=>{
 const f=await fixture();try{const u=await f.start();const callback='/auth/instagram/callback?code=synthetic-code&state='+u.searchParams.get('state');const r=await f.request(callback);assert.equal(r.headers.get('location'),'/app?notice=connected');assert.equal(f.saved[0].values.instagram_id,'17841400000000000');assert.deepEqual(f.saved[0].filters,[['id','seller-owned']]);assert.equal(f.saved[0].values.page_access_token,'synthetic-long');assert.equal(f.records[1].body,'subscribed_fields=messages');const s=await f.status();assert.equal(s.connected,true);assert.equal(s.products,23);assert.equal(JSON.stringify(s).includes('synthetic-'),false);assert.equal((await f.request(callback)).headers.get('location'),'/app?notice=invalid_state');
 assert.equal((await f.request('/app/disconnect',{method:'POST',headers:{origin:'https://evil.example','x-csrf-token':s.csrf}})).status,403);
 assert.equal((await f.request('/app/disconnect',{method:'POST',headers:{origin:f.base,'x-csrf-token':s.csrf}})).status,200);const update=f.saved.find(x=>x.values?.is_active===false);assert.deepEqual(update.filters,[['id','seller-owned']]);assert.equal(update.values.page_access_token,null);assert.equal((await f.status()).connected,false);
 }finally{await f.close();}
});
test('declined permissions and failed subscriptions never create a connected session',async()=>{
 for(const opt of [{partial:true},{subscriptionFailure:true}]){const f=await fixture(opt);try{const u=await f.start();const r=await f.request('/auth/instagram/callback?code=x&state='+u.searchParams.get('state'));assert.match(r.headers.get('location'),/missing_permissions|connection_failed/);assert.equal((await f.status()).connected,false);assert.equal(f.saved.filter(x=>x.values).length,0);}finally{await f.close();}}
});
test('cancellation, session isolation and cross-site start are handled safely',async()=>{
 const f=await fixture();try{assert.equal((await f.request('/auth/instagram/start',{method:'POST'})).status,403);const u=await f.start();assert.equal((await f.request('/auth/instagram/callback?error=access_denied&state='+u.searchParams.get('state'))).headers.get('location'),'/app?notice=cancelled');assert.equal(f.calls(),0);const r=await f.request('/app');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-frame-options'),'DENY');assert.equal((await f.request('/app/disconnect',{method:'POST',headers:{origin:f.base,'x-csrf-token':(await f.status()).csrf}})).status,401);}finally{await f.close();}
});
test('dashboard sample gallery serves JPEG assets and rejects non-catalog paths',async()=>{
 const f=await fixture();try{
 const page=await f.request('/app');const html=await page.text();assert.match(html,/AI-generated illustrations/);
 for(const sku of ['KRT-006','KRT-001','ACC-001','ACC-002','ACC-003']){const r=await f.request('/catalog/'+sku+'.jpg');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/jpeg/);const bytes=new Uint8Array(await r.arrayBuffer());assert.equal(bytes[0],255);assert.equal(bytes[1],216);}
 assert.equal((await f.request('/catalog/portal.js')).status,404);
 }finally{await f.close();}
});
