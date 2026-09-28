// ═══════════════════════════════════════════════════════════════
// InstaSell AI — Server v4.0 (THE AMAZON OF INSTAGRAM DMs)
// Visual Search + Outfit Completion + Buyer Memory + Smart Pricing
// Voice Notes + Drop Alerts + Multi-Order + Photo Catalog
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { db: { schema: 'sellerbot' } }
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'instasell_verify_2024';
const APP_SECRET   = process.env.APP_SECRET || '';
const IG_API_BASE  = 'https://graph.instagram.com/v21.0';

const OPT_OUT_WORDS = ['stop','unsubscribe','opt out','band karo','mat bhejo','dont message'];
const HUMAN_WORDS   = ['human','real person','owner','seller','insaan','asli insaan','talk to someone','khud baat karo'];
const DROP_ALERT_WORDS = ['notify me','batana','alert me','jab aaye','new collection','naya aaye toh'];

app.use(express.json({ verify: (req,res,buf) => { req.rawBody = buf; } }));

// ═══ WEBHOOK VERIFICATION ═══
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// ═══ MAIN WEBHOOK ═══
app.post('/webhook', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
      if (sig !== expected) return;
    }
  }
  const body = req.body;
  if (body.object !== 'instagram') return;
  body.entry?.forEach(entry => {
    entry.messaging?.forEach(event => {
      if (event.message && !event.message.is_echo) {
        handleIncomingDM(event).catch(err => console.error('DM error:', err.message));
      }
      if (event.message_delete) {
        handleMessageDeletion(event.message_delete.mid);
      }
    });
  });
});

// ═══ MAIN DM HANDLER ═══
async function handleIncomingDM(event) {
  const buyerIgId  = event.sender.id;
  const sellerIgId = event.recipient.id;
  const text       = event.message?.text || '';
  const messageId  = event.message?.mid;
  const attachments = event.message?.attachments || [];

  // Detect message type
  const imageUrl = attachments.find(a => a.type === 'image')?.payload?.url || null;
  const audioUrl = attachments.find(a => a.type === 'audio')?.payload?.url || null;
  const msgType  = audioUrl ? 'voice' : imageUrl ? 'image' : 'text';

  console.log(`\n📩 DM [${msgType}]: "${text || '[media]'}" | Buyer:${buyerIgId}`);

  // Load seller
  const { data: seller, error: sellerError } = await supabase
    .from('sellers').select('*').eq('instagram_id', sellerIgId).maybeSingle();
  if (sellerError) {
    console.error('Seller lookup failed:', sellerError.code, sellerError.message);
    return;
  }
  if (!seller) { console.error('Seller not found for recipient:', sellerIgId); return; }
  console.log('Seller matched:', seller.instagram_username);
  const TOKEN = seller.page_access_token || process.env.PAGE_ACCESS_TOKEN;

  const lower = (text || '').toLowerCase();

  // Opt-out check
  if (OPT_OUT_WORDS.some(w => lower.includes(w))) {
    return handleOptOut(buyerIgId, sellerIgId, TOKEN);
  }
  // Human handoff check
  if (HUMAN_WORDS.some(w => lower.includes(w))) {
    return handleHumanHandoff(buyerIgId, sellerIgId, TOKEN, seller);
  }

  // Load/create buyer
  let { data: buyer } = await supabase
    .from('buyers').select('*').eq('instagram_id', buyerIgId).single();
  if (!buyer) {
    const { data: nb } = await supabase
      .from('buyers').insert({ instagram_id: buyerIgId }).select().single();
    buyer = nb;
    console.log('👤 New buyer');
  }
  if (buyer?.is_opted_out) {
    if (!['start', 'resume', 'subscribe'].includes(lower.trim())) {
      console.log('Opted out: send START to resume shopping');
      return;
    }
    const { error: resumeError } = await supabase.from('buyers')
      .update({ is_opted_out: false }).eq('id', buyer.id);
    if (resumeError) throw new Error('Could not resume shopping: ' + resumeError.message);
    buyer.is_opted_out = false;
    console.log('Buyer explicitly resumed shopping');
  }

  // Drop alert check
  if (DROP_ALERT_WORDS.some(w => lower.includes(w))) {
    return handleDropAlert(buyerIgId, sellerIgId, TOKEN, seller, buyer, lower);
  }

  // Load/create conversation (allow multi-order by including 'ordered' status)
  let { data: conv } = await supabase
    .from('conversations').select('*')
    .eq('seller_id', seller.id).eq('buyer_id', buyer.id)
    .in('status', ['active', 'ordered'])
    .order('created_at', { ascending: false }).limit(1).single();

  if (!conv) {
    const { data: nc } = await supabase
      .from('conversations').insert({
        seller_id: seller.id, buyer_id: buyer.id,
        window_expires_at: new Date(Date.now() + 24*60*60*1000).toISOString()
      }).select().single();
    conv = nc;
  }

  if (conv.status === 'ordered') {
    await supabase.from('conversations').update({ status: 'active' }).eq('id', conv.id);
  }

  // Save incoming message
  const msgContent = imageUrl ? `[BUYER_PHOTO:${imageUrl}]` : audioUrl ? '[VOICE_NOTE]' : (text || 'hi');
  await supabase.from('messages').insert({
    conversation_id: conv.id, instagram_mid: messageId,
    role: 'buyer', content: msgContent, message_type: msgType
  });

  // Load products with pairings
  const { data: products } = await supabase
    .from('products')
    .select('*, product_stock(variant, stock), categories(name, emoji)')
    .eq('seller_id', seller.id).eq('is_active', true);

  // Load outfit pairings
  const { data: pairings } = await supabase
    .from('product_pairs').select('*')
    .in('product_id', products.map(p => p.id));

  // Load categories
  const { data: categories } = await supabase
    .from('categories').select('*')
    .eq('seller_id', seller.id).order('sort_order');

  // Load conversation history
  const { data: history } = await supabase
    .from('messages').select('role, content, message_type')
    .eq('conversation_id', conv.id).eq('is_deleted', false)
    .order('created_at', { ascending: true }).limit(30);

  // Build AI messages — handle images specially
  const aiMessages = [];
  for (const m of (history || [])) {
    const role = m.role === 'buyer' ? 'user' : 'assistant';
    
    // If buyer sent a photo, use vision
    if (m.content.startsWith('[BUYER_PHOTO:')) {
      const photoUrl = m.content.match(/\[BUYER_PHOTO:(.*?)\]/)?.[1];
      if (photoUrl && role === 'user') {
        aiMessages.push({
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: photoUrl } },
            { type: 'text', text: 'The buyer sent this photo. Match it against our catalog and suggest the closest products we have. If it looks like a product screenshot, identify the style, color, and type.' }
          ]
        });
        continue;
      }
    }
    
    if (m.content === '[VOICE_NOTE]') {
      aiMessages.push({ role, content: 'The buyer sent a voice note. Since I cannot listen to it, politely ask them to type their message or describe what they want.' });
      continue;
    }
    if (m.content && m.content.trim())
    aiMessages.push({ role, content: m.content });
  }

  // Build system prompt with all features
  const systemPrompt = buildSystemPromptV4(seller, products, categories, pairings, buyer);

  // Call Claude AI
  console.log('🧠 Calling Claude AI...');
  let rawReply = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: systemPrompt,
      messages: aiMessages
    });
    rawReply = response?.content?.[0]?.text || 'Sorry, could you say that again? 😊';
  } catch (aiErr) {
    console.log('❌ AI error:', aiErr.message);
    rawReply = 'Sorry yaar, give me one second! Could you type that again? 😊';
  }

  console.log('🤖 AI:', rawReply.substring(0, 150) + '...');

  // Parse photo tags [SEND_PHOTOS:SKU1,SKU2,...]
  const photoMatch = rawReply.match(/\[SEND_PHOTOS:([^\]]+)\]/);
  const cleanReply = rawReply
    .replace(/\[SEND_PHOTOS:[^\]]+\]/g, '')
    .replace(/<<<ORDER_CONFIRMED>>>[\s\S]*?<<<END_ORDER>>>/g, '')
    .trim();

  // Send product photos
  if (photoMatch) {
    const skus = photoMatch[1].split(',').map(s => s.trim());
    console.log('📸 Sending photos:', skus);
    await sendProductPhotos(sellerIgId, buyerIgId, skus, products, TOKEN);
  }

  // Send text reply
  if (cleanReply) {
    await sendInstagramDM(sellerIgId, buyerIgId, cleanReply, TOKEN);
  }

  // Parse and capture order
  const order = parseOrder(rawReply);
  if (order) {
    await captureOrder(order, seller, buyer, conv, products);
    // Track activity
    await trackActivity(buyer.id, seller.id, 'ordered', order.product_id);
  }

  // Save AI reply
  await supabase.from('messages').insert({
    conversation_id: conv.id, role: 'ai', content: cleanReply
  });

  // Update conversation
  await supabase.from('conversations').update({
    last_message_at: new Date().toISOString(),
    message_count: (conv.message_count || 0) + 2
  }).eq('id', conv.id);

  // Update product enquiry count for viewed products
  if (photoMatch) {
    const skus = photoMatch[1].split(',').map(s => s.trim());
    for (const sku of skus) {
      await supabase.from('products')
        .update({ enquiry_count: supabase.raw ? 0 : 0 }) // Will use RPC later
        .eq('sku', sku);
    }
  }

  // Update buyer preferences from conversation
  await updateBuyerPreferences(buyer, text, products);
}


// ═══ BUILD SYSTEM PROMPT V4.0 — THE AMAZON OF DMs ═══
function buildSystemPromptV4(seller, products, categories, pairings, buyer) {
  // Category menu
  const catMenu = (categories || []).map(c => {
    const cp = products.filter(p => p.category_id === c.id);
    if (cp.length === 0) return null;
    const prices = cp.map(p => p.listed_price);
    return `${c.emoji} ${c.name} (${cp.length} items) — ₹${Math.min(...prices)}–₹${Math.max(...prices)}`;
  }).filter(Boolean).join('\n');

  // Full catalog
  const catalog = products.map(p => {
    const stock = p.product_stock?.map(s => `${s.variant}:${s.stock}`).join(',') || '?';
    const oos = p.product_stock?.filter(s => s.stock === 0).map(s => s.variant) || [];
    const clearance = p.clearance ? ' [CLEARANCE—be generous with price]' : '';
    const demand = p.demand_level === 'high' ? ' [HIGH DEMAND—hold price firm]' : '';
    return `[${p.sku}] "${p.name}" ₹${p.listed_price}(min₹${p.min_price}) ${p.color}|${p.material}|${p.sizes?.join(',')}|Stock:${stock}|${p.occasion?.join(',')}|${p.tags?.join(',')}${clearance}${demand}${oos.length ? '|SOLD OUT:'+oos.join(',') : ''}`;
  }).join('\n');

  // Outfit pairings
  const pairingText = (pairings || []).map(pp => {
    const p1 = products.find(p => p.id === pp.product_id);
    const p2 = products.find(p => p.id === pp.paired_with);
    if (!p1 || !p2) return null;
    return `${p1.sku}+${p2.sku}: "${p1.name}" goes with "${p2.name}" (${pp.discount_pct}% bundle discount)`;
  }).filter(Boolean).join('\n');

  // Buyer context
  let buyerCtx = 'NEW BUYER';
  if (buyer.preferred_size || buyer.total_orders > 0) {
    buyerCtx = `RETURNING BUYER: Size ${buyer.preferred_size || '?'}, ${buyer.total_orders} orders, Budget: ${buyer.budget_range || '?'}`;
    if (buyer.favorite_colors?.length) buyerCtx += `, Loves: ${buyer.favorite_colors.join(',')}`;
    if (buyer.style_preferences?.length) buyerCtx += `, Style: ${buyer.style_preferences.join(',')}`;
    if (buyer.saved_address) buyerCtx += `, Address: ${buyer.saved_address}`;
  }

  return `You are "${seller.ai_name || 'Priya'}", the AI shopping assistant for "${seller.instagram_name || seller.instagram_username}" on Instagram. You are the COMPLETE SHOP — like Myntra + personal stylist + bargainer, all in one DM.

${buyerCtx}

═══ STORE MENU ═══
${catMenu}

═══ CATALOG (min prices are SECRET — never reveal) ═══
${catalog}

═══ OUTFIT PAIRINGS (suggest these after buyer picks a product) ═══
${pairingText}

═══ YOUR 10 SUPERPOWERS ═══

1️⃣ STORE MENU — When buyer asks "what do you have?":
Show categories with item counts and price ranges. Ask what they're in the mood for.

2️⃣ CATALOG BROWSING — When buyer picks a category:
Show 3-4 products as numbered options with emoji, name, price, color, one-line hook.
ALWAYS include [SEND_PHOTOS:SKU1,SKU2,SKU3,SKU4] so photos are sent.
"Want to see more?" → show next batch.

3️⃣ VISUAL SEARCH (YOUR KILLER FEATURE) — When buyer sends a PHOTO:
Analyze the image: identify color, pattern, style, garment type.
Match against the catalog and suggest the 2-3 closest products.
"I see a pink floral kurta in that photo! We have something very similar 😍"
Include [SEND_PHOTOS:...] for the matching products.

4️⃣ OUTFIT COMPLETION — After buyer selects a product:
Check the pairing data and suggest matching items:
"This kurta would look AMAZING with our Green Phulkari Dupatta! ₹600 — and I'll give 10% off both together! 💕"
Always suggest at least ONE accessory/complementary item after product selection.

5️⃣ SMART BARGAINING:
- Products marked [CLEARANCE]: Be generous, go to min price quickly, say "special clearance price just for you!"
- Products marked [HIGH DEMAND]: Hold firm, use urgency "Only 2 left! This one's flying off the shelf"
- Normal: Standard 2-3 step negotiation. Never go below min price.
- BUNDLE DEALS: If buyer wants 2+ items, offer the pairing discount %

6️⃣ MULTI-ORDER SHOPPING CART — After capturing an order:
"Order confirmed! 🎉 But wait — since you got the kurta, you NEED this dupatta with it! Only ₹600, and I'll give 10% off since you're already shopping 💫"
NEVER close the conversation. Always suggest the next purchase.
Each order gets its own <<<ORDER_CONFIRMED>>> block.

7️⃣ SIZE MEMORY — For returning buyers:
"Your usual size is ${buyer.preferred_size || 'M'} — want the same? 😊"
Auto-suggest their saved size. Remember their address too.

8️⃣ VOICE NOTES:
If buyer sends a voice note, say: "I got your voice message! 🎤 I can't listen to audio yet, but I'd love to help — could you type what you're looking for? Or just send a screenshot! 📸"

9️⃣ DROP ALERTS:
If buyer says "notify me when new stuff comes" or "naya aaye toh batana":
"Done! 🔔 I'll ping you when we add new stuff to the collection! What category interests you most — kurtas, sarees, western?"
(System handles the actual alert storage)

🔟 PERSONALIZED RECOMMENDATIONS — For returning buyers:
Use their favorite colors, past sizes, and style preferences to prioritize products.
"Since you loved blue last time, check out our new Blue Floral Rayon Kurta! 💙"

═══ ORDER CAPTURE ═══
When product ✓ size ✓ price ✓ address ✓ are ALL confirmed:
<<<ORDER_CONFIRMED>>>
{"product":"EXACT_NAME","product_id":"SKU","size":"SIZE","price":NUMBER,"address":"ADDRESS","buyer_name":"NAME"}
<<<END_ORDER>>>

═══ STYLE ═══
- 2-3 lines max. This is Instagram DM, not email.
- Numbered lists for products. Emojis per item.
- Hinglish: "yaar", "bilkul", "ekdum sahi", "kya baat hai"
- ALWAYS include [SEND_PHOTOS:...] when showing products
- After EVERY order: suggest a complementary product
- NEVER say goodbye first — always offer more shopping
- Be proud of your collection: "You have GREAT taste!"`;
}


// ═══ SEND PRODUCT PHOTOS ═══
async function sendProductPhotos(sellerIgId, buyerIgId, skus, products, token) {
  for (const sku of skus) {
    const product = products.find(p => p.sku === sku || p.name.toLowerCase().includes(sku.toLowerCase()));
    if (!product || !product.image_url) continue;
    try {
      await axios.post(`${IG_API_BASE}/me/messages`, {
        recipient: { id: buyerIgId },
        message: { attachment: { type: 'image', payload: { url: product.image_url } } }
      }, { headers: { Authorization: `Bearer ${token}` } });
      console.log(`📸 Photo sent: ${product.name}`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`📸 Photo skip: ${product.name} —`, err.response?.data?.error?.message || err.message);
    }
  }
}


// ═══ DROP ALERT HANDLER ═══
async function handleDropAlert(buyerIgId, sellerIgId, token, seller, buyer, text) {
  console.log('🔔 Drop alert request:', buyerIgId);
  
  // Determine category interest
  let category = null;
  if (text.includes('kurta')) category = 'kurta';
  else if (text.includes('saree')) category = 'saree';
  else if (text.includes('western')) category = 'western';
  
  await supabase.from('drop_alerts').insert({
    buyer_id: buyer.id,
    seller_id: seller.id,
    alert_type: 'new_collection',
    category: category,
    keywords: text.split(' ').filter(w => w.length > 3)
  });

  await sendInstagramDM(sellerIgId, buyerIgId,
    `Done! 🔔 I'll message you when we add new ${category || 'items'} to our collection. You won't miss a thing! 💫`, token);
}


// ═══ UPDATE BUYER PREFERENCES ═══
async function updateBuyerPreferences(buyer, text, products) {
  if (!text) return;
  const lower = text.toLowerCase();
  const updates = {};

  // Detect color preferences
  const colors = ['red','blue','green','pink','yellow','black','white','peach','lavender','olive'];
  const mentioned = colors.filter(c => lower.includes(c));
  if (mentioned.length > 0) {
    const existing = buyer.favorite_colors || [];
    updates.favorite_colors = [...new Set([...existing, ...mentioned])];
  }

  // Detect budget
  const priceMatch = lower.match(/(\d{3,5})/);
  if (priceMatch && lower.includes('budget')) {
    updates.budget_range = `under ₹${priceMatch[1]}`;
  }

  // Detect occasion
  const occasions = ['wedding','party','casual','office','festive','daily'];
  const mentionedOcc = occasions.filter(o => lower.includes(o));
  if (mentionedOcc.length > 0) {
    const existing = buyer.occasions || [];
    updates.occasions = [...new Set([...existing, ...mentionedOcc])];
  }

  // Detect category browsing
  if (lower.includes('kurta')) updates.last_browsed_category = 'kurta';
  else if (lower.includes('saree')) updates.last_browsed_category = 'saree';
  else if (lower.includes('western') || lower.includes('jeans') || lower.includes('dress')) updates.last_browsed_category = 'western';

  if (Object.keys(updates).length > 0) {
    await supabase.from('buyers').update(updates).eq('id', buyer.id);
  }
}


// ═══ TRACK BUYER ACTIVITY ═══
async function trackActivity(buyerId, sellerId, activity, productId) {
  try {
    await supabase.from('buyer_activity').insert({
      buyer_id: buyerId, seller_id: sellerId,
      activity, product_id: productId || null
    });
  } catch (e) {}
}


// ═══ PARSE ORDER ═══
function parseOrder(text) {
  const m = text.match(/<<<ORDER_CONFIRMED>>>([\s\S]*?)<<<END_ORDER>>>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}


// ═══ CAPTURE ORDER ═══
async function captureOrder(orderData, seller, buyer, conv, products) {
  try {
    console.log('📦 Order:', JSON.stringify(orderData));
    const product = products.find(p =>
      p.name.toLowerCase() === (orderData.product || '').toLowerCase() || p.sku === orderData.product_id
    );

    if (product && orderData.size) {
      try { await supabase.rpc('decrement_stock', { p_product_id: product.id, p_variant: orderData.size }); } catch (e) {}
    }

    const { data: order, error } = await supabase.from('orders').insert({
      seller_id: seller.id, buyer_id: buyer.id,
      product_id: product?.id, conversation_id: conv.id,
      product_name: orderData.product || 'Unknown',
      size: orderData.size || '', listed_price: product?.listed_price || 0,
      agreed_price: orderData.price || 0, delivery_address: orderData.address || '',
      buyer_name: orderData.buyer_name || '', status: 'pending_payment',
      ai_messages_count: conv.message_count || 0
    }).select().single();

    if (error) { console.log('❌ Order err:', error.message); return null; }
    console.log('✅ Order saved!', order.id);

    try { await supabase.rpc('increment_seller_orders', { p_seller_id: seller.id }); } catch (e) {}
    try { await supabase.rpc('increment_buyer_orders', { p_buyer_id: buyer.id, p_size: orderData.size || '', p_address: orderData.address || '' }); } catch (e) {}

    await supabase.from('conversations').update({ status: 'ordered' }).eq('id', conv.id);
    return order;
  } catch (err) { console.log('❌ Order fail:', err.message); return null; }
}


// ═══ SEND TEXT DM ═══
async function sendInstagramDM(sellerIgId, buyerIgId, text, token) {
  if (!token) { console.log('⚠️ No token'); return; }
  
  // Split long messages into chunks of max 500 chars
  const chunks = [];
  if (text.length > 500) {
    const parts = text.split('\n\n');
    let current = '';
    for (const part of parts) {
      if ((current + '\n\n' + part).length > 500 && current) {
        chunks.push(current.trim());
        current = part;
      } else {
        current = current ? current + '\n\n' + part : part;
      }
    }
    if (current) chunks.push(current.trim());
  } else {
    chunks.push(text);
  }
  
  for (const chunk of chunks) {
    try {
      await axios.post(`${IG_API_BASE}/me/messages`, {
        recipient: { id: buyerIgId },
        message: { text: chunk }
      }, { headers: { Authorization: `Bearer ${token}` } });
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error('❌ Send fail:', err.response?.data?.error?.message || err.message);
    }
  }
  console.log('✅ Sent to Instagram (' + chunks.length + ' msgs)');
}


// ═══ OPT-OUT ═══
async function handleOptOut(buyerIgId, sellerIgId, token) {
  await supabase.from('buyers').update({ is_opted_out: true }).eq('instagram_id', buyerIgId);
  await sendInstagramDM(sellerIgId, buyerIgId,
    "No problem! Messages stopped. Shop with us anytime by messaging again 😊", token);
}

// ═══ HUMAN HANDOFF ═══
async function handleHumanHandoff(buyerIgId, sellerIgId, token, seller) {
  await supabase.from('conversations').update({ status: 'human_handoff' }).eq('seller_id', seller.id);
  await sendInstagramDM(sellerIgId, buyerIgId,
    "Of course! Notifying the owner right now 🙏 They'll reply shortly!", token);
}

// ═══ MESSAGE DELETION ═══
async function handleMessageDeletion(mid) {
  if (!mid) return;
  await supabase.from('messages').update({ is_deleted: true, content: '[deleted]' }).eq('instagram_mid', mid);
}


// ═══ API ENDPOINTS ═══
app.get('/api/orders/:sellerId', async (req, res) => {
  const { data } = await supabase.from('orders').select('*')
    .eq('seller_id', req.params.sellerId).order('created_at', { ascending: false });
  res.json(data || []);
});
app.patch('/api/orders/:orderId', async (req, res) => {
  const { data } = await supabase.from('orders')
    .update(req.body).eq('id', req.params.orderId).select().single();
  res.json(data);
});
app.get('/api/products/:sellerId', async (req, res) => {
  const { data } = await supabase.from('products')
    .select('*, product_stock(*), categories(name, emoji)')
    .eq('seller_id', req.params.sellerId);
  res.json(data || []);
});
app.get('/api/categories/:sellerId', async (req, res) => {
  const { data } = await supabase.from('categories')
    .select('*').eq('seller_id', req.params.sellerId).order('sort_order');
  res.json(data || []);
});
app.get('/api/dashboard/:sellerId', async (req, res) => {
  try {
    const { data } = await supabase.from('seller_dashboard')
      .select('*').eq('seller_id', req.params.sellerId).single();
    res.json(data || {});
  } catch (e) { res.json({}); }
});
app.get('/api/buyer-activity/:sellerId', async (req, res) => {
  const { data } = await supabase.from('buyer_activity')
    .select('*').eq('seller_id', req.params.sellerId)
    .order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});

// Health
app.get('/', (req, res) => res.json({
  status: 'alive', service: 'InstaSell AI v4.0 — The Amazon of Instagram DMs',
  features: ['visual-search','outfit-completion','buyer-memory','smart-pricing','voice-detection','drop-alerts','multi-order','photo-catalog'],
  timestamp: new Date().toISOString()
}));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Register instagram_basic API call on startup
async function registerBasicCall() {
  const token = process.env.PAGE_ACCESS_TOKEN;
  if (token) {
    try {
      const res = await axios.get('https://graph.instagram.com/v21.0/me?fields=id,username', {
        headers: { Authorization: 'Bearer ' + token }
      });
      console.log('instagram_basic registered:', res.data);
    } catch (e) {
      console.log('instagram_basic call:', e.response?.data?.error?.message || e.message);
    }
  }
}
async function checkSellerDatabase() {
  const { data, error } = await supabase.from('sellers')
    .select('instagram_id, instagram_username');
  if (error) console.error('Seller database check failed:', error.code, error.message);
  else console.log('Seller database ready:', data);
}
checkSellerDatabase().catch(err => console.error('Seller database check failed:', err.message));
registerBasicCall();
app.listen(PORT, () => {
  console.log(`\n🚀 InstaSell AI v4.0 — The Amazon of Instagram DMs`);
  console.log('   Visual Search | Outfit Completion | Smart Pricing | Multi-Order\n');
});
