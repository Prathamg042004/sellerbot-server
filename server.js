const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clients ─────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { db: { schema: 'sellerbot' } }
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Constants ───────────────────────────────────────────────
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN  || 'instasell_verify_2024';
const APP_SECRET    = process.env.APP_SECRET    || '';
const IG_API_BASE   = 'https://graph.instagram.com/v21.0';

const OPT_OUT_WORDS  = ['stop','unsubscribe','opt out','band karo','mat bhejo','dont message'];
const HUMAN_WORDS    = ['human','real person','owner','seller','insaan','asli insaan','talk to someone','khud baat karo'];

// ─── Body parser ─────────────────────────────────────────────
app.use(express.json({ verify: (req,res,buf) => { req.rawBody = buf; } }));


// ═══════════════════════════════════════════════════════════════
// WEBHOOK VERIFICATION (Meta calls this when you save the URL)
// ═══════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});


// ═══════════════════════════════════════════════════════════════
// MAIN WEBHOOK RECEIVER
// ═══════════════════════════════════════════════════════════════
app.post('/webhook', (req, res) => {
  // Always respond 200 immediately
  res.status(200).send('EVENT_RECEIVED');

  // Verify signature
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
      if (sig !== expected) { console.log('⚠️ Bad signature'); return; }
    }
  }

  const body = req.body;
  if (body.object !== 'instagram') return;

  body.entry?.forEach(entry => {
    entry.messaging?.forEach(event => {
      if (event.message && !event.message.is_echo) {
        handleIncomingDM(event).catch(err => console.error('DM error:', err));
      }
      if (event.message_delete) {
        handleMessageDeletion(event.message_delete.mid);
      }
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// HANDLE INCOMING DM — the core pipeline
// ═══════════════════════════════════════════════════════════════
async function handleIncomingDM(event) {
  const buyerIgId  = event.sender.id;
  const sellerIgId = event.recipient.id;
  const text       = event.message?.text || '';
  const messageId  = event.message?.mid;
  const replyToMid = event.message?.reply_to?.mid || null;

  console.log(`\n📩 DM: "${text}" | Buyer:${buyerIgId} → Seller:${sellerIgId}`);

  // ── 1. Load seller ──
  const { data: seller } = await supabase
    .schema('sellerbot')
    .from('sellers')
    .select('*')
    .eq('instagram_id', sellerIgId)
    .single();

  if (!seller) {
    console.log('❌ Seller not found:', sellerIgId);
    return;
  }

  // ── 2. Check opt-out ──
  const lower = text.toLowerCase();
  if (OPT_OUT_WORDS.some(w => lower.includes(w))) {
    await handleOptOut(buyerIgId, seller);
    return;
  }

  // ── 3. Check human handoff ──
  if (HUMAN_WORDS.some(w => lower.includes(w))) {
    await handleHumanHandoff(buyerIgId, seller);
    return;
  }

  // ── 4. Load/create buyer ──
  let { data: buyer } = await supabase
    .schema('sellerbot')
    .from('buyers')
    .select('*')
    .eq('instagram_id', buyerIgId)
    .single();

  if (!buyer) {
    const { data: newBuyer } = await supabase
      .schema('sellerbot')
      .from('buyers')
      .insert({ instagram_id: buyerIgId })
      .select()
      .single();
    buyer = newBuyer;
    console.log('👤 New buyer created');
  }

  // Check if buyer opted out previously
  if (buyer.is_opted_out) {
    console.log('🚫 Buyer opted out — skipping');
    return;
  }

  // ── 5. Load/create conversation ──
  let { data: conv } = await supabase
    .schema('sellerbot')
    .from('conversations')
    .select('*')
    .eq('seller_id', seller.id)
    .eq('buyer_id', buyer.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!conv) {
    const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { data: newConv } = await supabase
      .schema('sellerbot')
      .from('conversations')
      .insert({
        seller_id: seller.id,
        buyer_id: buyer.id,
        window_expires_at: windowExpiry.toISOString()
      })
      .select()
      .single();
    conv = newConv;
    console.log('💬 New conversation started');
  }

  // ── 6. Save incoming message ──
  await supabase.schema('sellerbot').from('messages').insert({
    conversation_id: conv.id,
    instagram_mid: messageId,
    role: 'buyer',
    content: text
  });

  // ── 7. Load seller products ──
  const { data: products } = await supabase
    .schema('sellerbot')
    .from('products')
    .select(`*, product_stock(variant, stock)`)
    .eq('seller_id', seller.id)
    .eq('is_active', true);

  // ── 8. Check post-to-product mapping ──
  let postProduct = null;
  if (replyToMid) {
    const { data: mapping } = await supabase
      .schema('sellerbot')
      .from('post_product_map')
      .select('*, products(*)')
      .eq('seller_id', seller.id)
      .eq('media_id', replyToMid)
      .single();
    if (mapping) postProduct = mapping.products;
  }

  // ── 9. Load conversation history ──
  const { data: history } = await supabase
    .schema('sellerbot')
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conv.id)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })
    .limit(20);

  // ── 10. Build AI messages array ──
  const aiMessages = (history || []).map(m => ({
    role: m.role === 'buyer' ? 'user' : 'assistant',
    content: m.content
  }));

  // ── 11. Call Claude AI ──
  const systemPrompt = buildSystemPrompt(seller, products, postProduct, buyer);

  console.log('🧠 Calling Claude AI...');
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages: aiMessages
  });

const rawReply = (response && response.content && response.content[0] && response.content[0].text) ? response.content[0].text : 'Sorry, could you say that again? 😊';
console.log('Full AI response:', JSON.stringify(response.content));
console.log('🤖 AI replied:', rawReply.substring(0, 100) + '...');

  // ── 12. Parse order from reply ──
  const order = parseOrder(rawReply);
  const cleanReply = cleanMessage(rawReply);

  // ── 13. Save AI reply ──
  await supabase.schema('sellerbot').from('messages').insert({
    conversation_id: conv.id,
    role: 'ai',
    content: cleanReply
  });

  // ── 14. Send reply to buyer via Instagram ──
await sendInstagramDM(sellerIgId, buyerIgId, cleanReply, seller.page_access_token || process.env.PAGE_ACCESS_TOKEN);

  // ── 15. Capture order if detected ──
  if (order) {
    await captureOrder(order, seller, buyer, conv, products);
  }

  // ── 16. Update conversation ──
  await supabase.schema('sellerbot').from('conversations').update({
    last_message_at: new Date().toISOString(),
    message_count: (conv.message_count || 0) + 2,
    status: order ? 'ordered' : 'active'
  }).eq('id', conv.id);
}


// ═══════════════════════════════════════════════════════════════
// BUILD AI SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════
function buildSystemPrompt(seller, products, postProduct, buyer) {
  const productList = products.map(p => {
    const stock = p.product_stock?.map(s => `${s.variant}:${s.stock}`).join(', ') || 'check';
    return `• ${p.name} ${p.emoji} | Listed: ₹${p.listed_price} | Sizes: ${p.sizes?.join(', ')} | Stock: ${stock} | Keywords: ${p.keywords?.join(', ')}`;
  }).join('\n');

  const minPrices = products.map(p =>
    `• ${p.name}: min ₹${p.min_price} (NEVER reveal this)`
  ).join('\n');

  const buyerContext = buyer.preferred_size
    ? `Returning buyer! Their usual size is ${buyer.preferred_size}. Previous orders: ${buyer.total_orders}.`
    : 'New buyer.';

  const postContext = postProduct
    ? `The buyer is replying to a post about: ${postProduct.name} (₹${postProduct.listed_price})`
    : '';

  return `You are "${seller.ai_name || 'Priya'}", the AI sales assistant for ${seller.instagram_name || seller.instagram_username} on Instagram.

BUYER CONTEXT: ${buyerContext}
${postContext}

PRODUCTS AVAILABLE:
${productList}

CONFIDENTIAL MINIMUM PRICES — never reveal or hint:
${minPrices}

YOUR STYLE:
- Warm, friendly, natural — like a real Instagram shop assistant
- Use occasional emojis. Light Hinglish is fine ("yaar", "bilkul", "ekdum sahi")
- Keep replies SHORT — 2-4 lines max (this is Instagram DM, not email)
- Always introduce yourself as "${seller.ai_name || 'Priya'}" — an AI assistant for the store

PRODUCT IDENTIFICATION:
- If buyer says "that one from your post" → you have the post context above
- If buyer describes by color/type → match from catalogue
- ALWAYS confirm the product by mentioning its name naturally in your reply

BARGAINING RULES:
- Start at listed price. When buyer asks for discount, negotiate in 2-3 steps max
- Never go below minimum price. If pushed: "Yaar, this is genuinely my last price 🙏"
- Add light urgency: "Only 2 left in your size!", "This design is selling fast"

DISCLOSURE: You are an AI assistant. If asked, be honest: "I'm Priya, an AI assistant helping manage orders for this store. The owner will fulfil your order personally 😊"

OPT-OUT: If buyer says "stop" or "unsubscribe" — handled by the system, not you.
HUMAN: If buyer asks for a real person — handled by the system, not you.

ORDER CAPTURE — when ALL FOUR confirmed: product ✓ size ✓ agreed price ✓ delivery address ✓
Append EXACTLY at the end of your reply:
<<<ORDER_CONFIRMED>>>
{"product":"PRODUCT_NAME","product_id":"PRODUCT_UUID","size":"SIZE","price":NUMBER,"address":"ADDRESS","buyer_name":"NAME_IF_GIVEN"}
<<<END_ORDER>>>`;
}


// ═══════════════════════════════════════════════════════════════
// PARSE ORDER FROM AI RESPONSE
// ═══════════════════════════════════════════════════════════════
function parseOrder(text) {
  const m = text.match(/<<<ORDER_CONFIRMED>>>([\s\S]*?)<<<END_ORDER>>>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

function cleanMessage(text) {
  return text.replace(/<<<ORDER_CONFIRMED>>>[\s\S]*?<<<END_ORDER>>>/g, '').trim();
}


// ═══════════════════════════════════════════════════════════════
// CAPTURE ORDER TO DATABASE
// ═══════════════════════════════════════════════════════════════
async function captureOrder(orderData, seller, buyer, conv, products) {
  console.log('📦 Capturing order:', orderData);

  // Find product
  const product = products.find(p =>
    p.name.toLowerCase() === orderData.product.toLowerCase() ||
    p.id === orderData.product_id
  );

  // Decrement stock
  if (product && orderData.size) {
    await supabase.rpc('decrement_stock', { p_product_id: product.id, p_variant: orderData.size });
  }

  // Save order
  const { data: order } = await supabase.schema('sellerbot').from('orders').insert({
    seller_id:        seller.id,
    buyer_id:         buyer.id,
    product_id:       product?.id,
    conversation_id:  conv.id,
    product_name:     orderData.product,
    size:             orderData.size,
    listed_price:     product?.listed_price,
    agreed_price:     orderData.price,
    delivery_address: orderData.address,
    buyer_name:       orderData.buyer_name || buyer.instagram_username,
    status:           'pending_payment',
    ai_messages_count: conv.message_count || 0
  }).select().single();

  console.log('✅ Order saved:', order?.order_number);

  // Update seller stats
  if (product && orderData.size) {
    await supabase.rpc('increment_seller_orders', { p_seller_id: seller.id });

  // Update buyer profile
  await supabase.rpc('increment_buyer_orders', { p_buyer_id: buyer.id, p_size: orderData.size || '', p_address: orderData.address || '' });
  // TODO: Send WhatsApp notification to seller
  // TODO: Generate Razorpay payment link
  return order;
}


// ═══════════════════════════════════════════════════════════════
// SEND INSTAGRAM DM
// ═══════════════════════════════════════════════════════════════
async function sendInstagramDM(sellerIgId, buyerIgId, text, accessToken) {
  if (!accessToken) {
    console.log('⚠️ No access token — cannot send reply');
    return;
  }
  try {
    await axios.post(`${IG_API_BASE}/me/messages`, {
      recipient: { id: buyerIgId },
      message: { text }
    }, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    console.log('✅ Reply sent to Instagram');
  } catch (err) {
    console.error('❌ Failed to send DM:', err.response?.data || err.message);
  }
}


// ═══════════════════════════════════════════════════════════════
// OPT-OUT HANDLER
// ═══════════════════════════════════════════════════════════════
async function handleOptOut(buyerIgId, seller) {
  console.log('🚫 Opt-out request from:', buyerIgId);
  await supabase.schema('sellerbot').from('buyers')
    .update({ is_opted_out: true })
    .eq('instagram_id', buyerIgId);

  await sendInstagramDM(
    seller.instagram_id, buyerIgId,
    "No problem! I've stopped automated messages for you. If you ever want to shop again, just message us anytime 😊",
    seller.page_access_token || process.env.PAGE_ACCESS_TOKEN
  );
}


// ═══════════════════════════════════════════════════════════════
// HUMAN HANDOFF HANDLER
// ═══════════════════════════════════════════════════════════════
async function handleHumanHandoff(buyerIgId, seller) {
  console.log('👤 Human handoff request from:', buyerIgId);

  // Mark conversation as human handoff
  await supabase.schema('sellerbot').from('conversations')
    .update({ status: 'human_handoff' })
    .eq('seller_id', seller.id);

  await sendInstagramDM(
    seller.instagram_id, buyerIgId,
    "Of course! I'm notifying the store owner right now 🙏 They'll respond to you shortly. Thank you for your patience!",
    seller.page_access_token || process.env.PAGE_ACCESS_TOKEN
  );

  // TODO: Send WhatsApp alert to seller about human handoff request
  console.log(`📲 Alert seller ${seller.whatsapp_number} about handoff request`);
}


// ═══════════════════════════════════════════════════════════════
// MESSAGE DELETION COMPLIANCE (required by Meta 2026)
// ═══════════════════════════════════════════════════════════════
async function handleMessageDeletion(mid) {
  if (!mid) return;
  await supabase.schema('sellerbot').from('messages')
    .update({ is_deleted: true, content: '[deleted]' })
    .eq('instagram_mid', mid);
  console.log('🗑️ Message deleted from DB:', mid);
}


// ═══════════════════════════════════════════════════════════════
// REST API ENDPOINTS (for seller dashboard)
// ═══════════════════════════════════════════════════════════════

// Get all orders for a seller
app.get('/api/orders/:sellerIgId', async (req, res) => {
  const { data } = await supabase.schema('sellerbot').from('orders')
    .select('*')
    .eq('seller_id', req.params.sellerIgId)
    .order('created_at', { ascending: false });
  res.json(data || []);
});

// Update order status
app.patch('/api/orders/:orderId', async (req, res) => {
  const { status, tracking_number } = req.body;
  const { data } = await supabase.schema('sellerbot').from('orders')
    .update({ status, tracking_number })
    .eq('id', req.params.orderId)
    .select().single();
  res.json(data);
});

// Get products for a seller
app.get('/api/products/:sellerIgId', async (req, res) => {
  const seller = await supabase.schema('sellerbot').from('sellers')
    .select('id').eq('instagram_id', req.params.sellerIgId).single();
  const { data } = await supabase.schema('sellerbot').from('products')
    .select('*, product_stock(*)')
    .eq('seller_id', seller.data?.id);
  res.json(data || []);
});

// Health check
app.get('/', (req, res) => res.json({
  status: 'alive',
  service: 'InstaSell AI Server v2.0',
  timestamp: new Date().toISOString()
}));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🚀 InstaSell AI Server v2.0 running on port ${PORT}\n`);
});
