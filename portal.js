'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
function mountPortal(app, { db, http, env = process.env, now = Date.now }) {
  const base = env.PUBLIC_BASE_URL || 'https://sellerbot-server.onrender.com';
  const redirectUri = base + '/auth/instagram/callback';
  const appId = env.INSTAGRAM_APP_ID || '1518243673369480';
  const secret = () => env.INSTAGRAM_APP_SECRET || env.APP_SECRET;
  const sessions = new Map();
  const random = () => crypto.randomBytes(32).toString('hex');
  function session(req, res, create = false) {
    for (const [id, s] of sessions) if (s.expires < now()) sessions.delete(id);
    const id = /(?:^|;\s*)sellerbot_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    let s = sessions.get(id);
    if (!s && create && sessions.size < 5000) {
      const key = random(); s = { csrf: random(), expires: now() + 8*3600000 };
      sessions.set(key, s);
      res.cookie('sellerbot_session', key, { httpOnly:true, secure:base.startsWith('https:'), sameSite:'lax', path:'/', maxAge:8*3600000 });
    }
    return s;
  }
  app.use(['/app', '/auth'], (req,res,next) => {
    res.set({ 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.get('/', (req,res) => res.redirect('/app'));
  app.get('/app', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
  app.get('/catalog/:file', (req,res) => {
    if (!/^(ACC|KRT|SAR|SET|WST)-[0-9]{3}\.jpg$/.test(req.params.file)) return res.sendStatus(404);
    res.set({'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});
    res.sendFile(path.join(__dirname,'public','catalog',req.params.file));
  });
  app.get('/app/style.css', (req,res) => res.sendFile(path.join(__dirname,'public','style.css')));
  app.get('/app/app.js', (req,res) => res.sendFile(path.join(__dirname,'public','app.js')));
  function csrf(req,res,next) {
    const s = session(req,res);
    if (!s || req.headers.origin !== base || req.headers['x-csrf-token'] !== s.csrf) return res.status(403).json({error:'Refresh this page and try again.'});
    req.portalSession=s; next();
  }
  app.get('/app/status', async (req,res) => {
    const s = session(req,res,true);
    if (!s) return res.status(503).json({error:'Please try again shortly.'});
    if (!s.sellerId) return res.json({ connected:false, csrf:s.csrf, configured:!!secret(), scopes:SCOPES });
    try {
      const {data:seller,error} = await db.from('sellers').select('id,instagram_username,is_active').eq('id',s.sellerId).single();
      if (error || !seller) throw Error('Account unavailable');
      const {count,error:countError} = await db.from('products').select('id',{count:'exact',head:true}).eq('seller_id',s.sellerId).eq('is_active',true);
      if (countError) throw Error('Catalog unavailable');
      res.json({connected:seller.is_active===true, username:seller.instagram_username, products:count, csrf:s.csrf, scopes:SCOPES, expiresAt:s.tokenExpiresAt, configured:!!secret()});
    } catch {res.status(503).json({error:'Could not load your connection. Please try again.'});}
  });
  app.post('/auth/instagram/start', csrf, (req,res) => {
    if (!secret()) return res.status(503).json({error:'Instagram connection is not configured yet.'});
    const s=req.portalSession; s.state=random(); s.stateExpires=now()+10*60000;
    const url=new URL('https://www.instagram.com/oauth/authorize');
    url.search=new URLSearchParams({client_id:appId,redirect_uri:redirectUri,response_type:'code',scope:SCOPES.join(','),state:s.state,enable_fb_login:'false'}).toString();
    res.json({url:url.toString()});
  });
  app.get('/auth/instagram/callback', async (req,res) => {
    const s=session(req,res);
    if (!s || typeof req.query.state!=='string' || !s.state || s.state!==req.query.state || s.stateExpires<now()) return res.redirect('/app?notice=invalid_state');
    delete s.state; delete s.stateExpires;
    if (req.query.error) return res.redirect('/app?notice=cancelled');
    if (typeof req.query.code!=='string' || req.query.code.length>4096) return res.redirect('/app?notice=missing_code');
    try {
      const form=new URLSearchParams({client_id:appId,client_secret:secret(),grant_type:'authorization_code',redirect_uri:redirectUri,code:req.query.code});
      const shortResponse=await http.post('https://api.instagram.com/oauth/access_token',form.toString(),{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout:20000});
      const auth=shortResponse.data.data?.[0] || shortResponse.data;
      const granted=Array.isArray(auth.permissions)?auth.permissions:String(auth.permissions||'').split(',').map(x=>x.trim());
      if (!auth.access_token || !SCOPES.every(x=>granted.includes(x))) return res.redirect('/app?notice=missing_permissions');
      const extended=await http.get('https://graph.instagram.com/access_token',{params:{grant_type:'ig_exchange_token',client_secret:secret(),access_token:auth.access_token},timeout:20000});
      const token=extended.data.access_token;
      if (!token) throw Error('Missing extended token');
      const opts={headers:{Authorization:'Bearer '+token},timeout:20000};
      const profile=await http.get('https://graph.instagram.com/v25.0/me',{...opts,params:{fields:'user_id,username'}});
      const identity=profile.data;
      if (!/^\d+$/.test(String(identity.user_id)) || !identity.username) throw Error('Invalid Instagram identity');
      // Account ownership is established by Meta, never by a client-supplied seller ID.
      const {data:existing,error:lookupError}=await db.from('sellers').select('id').eq('instagram_id',String(identity.user_id)).maybeSingle();
      if (lookupError) throw Error('Account lookup failed');
      // Subscribe before persisting; a failed subscription must not be shown as connected.
      const subscription=await http.post('https://graph.instagram.com/v25.0/'+identity.user_id+'/subscribed_apps',new URLSearchParams({subscribed_fields:'messages'}).toString(),{...opts,headers:{...opts.headers,'Content-Type':'application/x-www-form-urlencoded'}});
      if (subscription.data.success!==true) throw Error('Subscription not confirmed');
      const fields={instagram_id:String(identity.user_id),instagram_username:identity.username,page_access_token:token,is_active:true};
      const write=existing ? db.from('sellers').update(fields).eq('id',existing.id) : db.from('sellers').insert(fields);
      const {data:saved,error:saveError}=await write.select('id').single();
      if (saveError || !saved) throw Error('Connection could not be saved');
      s.sellerId=saved.id; s.tokenExpiresAt=new Date(now()+Number(extended.data.expires_in||0)*1000).toISOString(); s.csrf=random();
      console.log('Instagram account connected through business login');
      return res.redirect('/app?notice=connected');
    } catch (error) {
      // Never log axios errors: request configs can include credentials or authorization codes.
      console.error('Instagram connection failed:',error.response?.status || 'connection_error');
      return res.redirect('/app?notice=connection_failed');
    }
  });
  app.post('/app/logout',csrf,(req,res)=>{delete req.portalSession.sellerId;delete req.portalSession.tokenExpiresAt;req.portalSession.csrf=random();res.json({ok:true});});
  app.post('/app/disconnect',csrf,async(req,res)=>{
    const s=req.portalSession;
    if (!s.sellerId) return res.status(401).json({error:'Connect an Instagram account first.'});
    try {
      const {error}=await db.from('sellers').update({is_active:false,page_access_token:null}).eq('id',s.sellerId);
      if(error) throw Error('Disconnect failed');
      delete s.sellerId;delete s.tokenExpiresAt;s.csrf=random();
      res.json({ok:true});
    } catch {res.status(503).json({error:'Could not disconnect. Please try again.'});}
  });
}
module.exports={mountPortal,SCOPES};
