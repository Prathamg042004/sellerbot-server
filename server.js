// ═══════════════════════════════════════════════════════
// InstaSell AI — Webhook Server
// This is the FIRST thing you deploy. Meta needs this
// live URL before you can configure webhooks.
// ═══════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const app = express();

// ─── Environment variables ───
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'instasell_verify_2024';
const APP_SECRET = process.env.APP_SECRET || '';  // From Meta App Dashboard

// Parse JSON body (needed for webhook POST events)
app.use(express.json({ 
  verify: (req, res, buf) => { req.rawBody = buf; } // Store raw body for signature verification
}));

// ═══════════════════════════════════════════════════════
// STEP 1: WEBHOOK VERIFICATION (GET request)
// 
// When you add your webhook URL in Meta's dashboard,
// Meta sends a GET request to verify you own the URL.
// Your server must respond with the hub.challenge value.
// If this doesn't work, you CANNOT save webhook config.
// ═══════════════════════════════════════════════════════

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔐 Webhook verification request received');
  console.log('   Mode:', mode);
  console.log('   Token:', token);

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully!');
    return res.status(200).send(challenge);
  }

  console.log('❌ Webhook verification failed — token mismatch');
  return res.status(403).send('Forbidden');
});

// ═══════════════════════════════════════════════════════
// STEP 2: RECEIVE INSTAGRAM EVENTS (POST request)
// 
// After verification, Instagram sends POST requests here
// whenever a DM is received, a comment is posted, etc.
// This is where your entire product starts.
// ═══════════════════════════════════════════════════════

app.post('/webhook', (req, res) => {
  const body = req.body;

  // Always respond 200 immediately — Meta requires this within 5 seconds
  // If you don't, Meta will retry and eventually disable your webhook
  res.status(200).send('EVENT_RECEIVED');

  // Verify the request is actually from Meta (security)
  if (APP_SECRET) {
    const signature = req.headers['x-hub-signature-256'];
    if (signature) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
      if (signature !== expected) {
        console.log('⚠️ Invalid signature — ignoring request');
        return;
      }
    }
  }

  if (body.object === 'instagram') {
    body.entry?.forEach(entry => {
      // ─── Handle DM messages ───
      entry.messaging?.forEach(event => {
        if (event.message) {
          handleNewMessage(event);
        }
        if (event.postback) {
          handlePostback(event);
        }
      });

      // ─── Handle comment events ───
      entry.changes?.forEach(change => {
        if (change.field === 'comments') {
          handleComment(change.value);
        }
      });
    });
  }

  // ─── Handle message_deletions (REQUIRED for 2026 compliance) ───
  if (body.object === 'instagram' && body.entry) {
    body.entry.forEach(entry => {
      entry.messaging?.forEach(event => {
        if (event.message_delete) {
          handleMessageDeletion(event);
        }
      });
    });
  }
});


// ═══════════════════════════════════════════════════════
// MESSAGE HANDLERS
// These are stubs right now — we'll build them out
// tomorrow when we start the AI engine
// ═══════════════════════════════════════════════════════

function handleNewMessage(event) {
  const senderId = event.sender.id;
  const recipientId = event.recipient.id;
  const messageText = event.message.text;
  const messageId = event.message.mid;
  const timestamp = event.timestamp;

  // Check if this is a reply to a specific post/story
  const replyTo = event.message.reply_to?.mid || null;

  console.log('═══════════════════════════════════════');
  console.log('📩 NEW DM RECEIVED');
  console.log(`   From: ${senderId}`);
  console.log(`   To: ${recipientId} (seller)`);
  console.log(`   Message: "${messageText}"`);
  console.log(`   Message ID: ${messageId}`);
  console.log(`   Reply to post: ${replyTo || 'none'}`);
  console.log(`   Time: ${new Date(timestamp).toLocaleString()}`);
  console.log('═══════════════════════════════════════');

  // TODO: Tomorrow we build:
  // 1. Look up seller by recipientId
  // 2. Look up or create buyer by senderId
  // 3. If replyTo exists, match to product via post mapping
  // 4. Load conversation history from Redis
  // 5. Build AI context + call Claude API
  // 6. Parse AI response for order data
  // 7. Send reply back via Instagram API
  // 8. Save conversation to Redis
}

function handlePostback(event) {
  console.log('🔘 Postback received:', JSON.stringify(event.postback));
}

function handleComment(commentData) {
  console.log('💬 New comment:', JSON.stringify(commentData));
  // TODO: Check for trigger keywords and send DM
}

function handleMessageDeletion(event) {
  const deletedMessageId = event.message_delete?.mid;
  console.log('🗑️ Message deleted by user:', deletedMessageId);
  // TODO: Delete stored message from database
  // This is REQUIRED for Meta compliance in 2026
}


// ═══════════════════════════════════════════════════════
// OPT-OUT HANDLER (REQUIRED for approval)
// If a user says "stop", "unsubscribe", etc. — stop messaging
// ═══════════════════════════════════════════════════════

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'opt out', 'dont message', 'leave me alone', 'band karo', 'mat bhejo'];
const HUMAN_WORDS = ['human', 'real person', 'owner', 'seller', 'insaan', 'asli', 'talk to someone'];

function checkOptOut(messageText) {
  const lower = messageText.toLowerCase().trim();
  if (OPT_OUT_WORDS.some(w => lower.includes(w))) return 'opt_out';
  if (HUMAN_WORDS.some(w => lower.includes(w))) return 'human_handoff';
  return null;
}


// ═══════════════════════════════════════════════════════
// HEALTH CHECK — Railway/Render need this
// ═══════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    service: 'InstaSell AI Webhook Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});


// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ═══════════════════════════════════════');
  console.log(`🚀  InstaSell AI Server running on port ${PORT}`);
  console.log('🚀 ═══════════════════════════════════════');
  console.log('');
  console.log(`   Webhook URL: https://your-app.railway.app/webhook`);
  console.log(`   Verify Token: ${VERIFY_TOKEN}`);
  console.log('');
  console.log('   Waiting for Instagram events...');
  console.log('');
});
