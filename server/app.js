import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, tx } from './db.js';
import { ingestCustomerMessage } from './ingest.js';
import { regenerateDraft } from './drafts.js';
import { login, requireAgent, loginRateLimit } from './auth.js';
import { log } from './log.js';

export const app = express();
app.set('trust proxy', 1);

const PHONE_RE = /^\+?[0-9]{7,15}$/;
const clean = (s) => String(s ?? '').trim();
const bad = (res, msg) => res.status(400).json({ error: msg });

/* ------------------------------------------------------------------ webhook */

export function verifySignature(rawBody, header, secret = config.webhookSecret) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header || '');
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return crypto.timingSafeEqual(expected, given);
}

function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'Body must be a JSON object';
  if (!clean(p.event_id)) return 'event_id is required';
  if (!clean(p.brand_id)) return 'brand_id is required';
  const c = p.customer;
  if (!c || !clean(c.id) || !clean(c.name) || !PHONE_RE.test(clean(c.phone))) return 'customer.id, customer.name and a valid customer.phone are required';
  const m = p.message;
  if (!m || !clean(m.id)) return 'message.id is required';
  return null;
}

// Raw body is needed to verify the signature, so this route is registered before express.json().
app.post('/webhook', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.get('x-signature'))) {
    log('error', 'webhook rejected: bad signature', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid signature' });
  }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return bad(res, 'Invalid JSON'); }

  const problem = validatePayload(payload);
  if (problem) return bad(res, problem);
  if (payload.brand_id !== config.brandId) return bad(res, `Unknown brand_id ${payload.brand_id}`);
  if (payload.type !== 'message.received') return res.status(200).json({ status: 'ignored', reason: `type ${payload.type}` });
  if (payload.message?.type !== 'text' || !clean(payload.message.text)) {
    return res.status(200).json({ status: 'ignored', reason: 'only non-empty text messages are supported' });
  }
  if (payload.message.text.length > config.maxMessageChars) return bad(res, 'message.text too long');

  const eventId = clean(payload.event_id);
  try {
    // Audit row first, so even a crash during processing leaves a trace we can find.
    await pool.query(
      `INSERT INTO webhook_events (event_id, brand_id, payload) VALUES ($1,$2,$3)
       ON CONFLICT (event_id) DO UPDATE SET updated_at = now()`,
      [eventId, payload.brand_id, payload],
    );
    const out = await ingestCustomerMessage({
      brandId: payload.brand_id,
      customer: { id: clean(payload.customer.id), name: clean(payload.customer.name), phone: clean(payload.customer.phone) },
      message: { id: clean(payload.message.id), text: clean(payload.message.text) },
    });
    await pool.query(`UPDATE webhook_events SET status='processed', error=NULL, updated_at=now() WHERE event_id=$1`, [eventId]);
    return res.status(200).json({ status: out.duplicate ? 'duplicate' : 'accepted', conversation_id: out.conversationId });
  } catch (e) {
    log('error', 'webhook processing failed', { eventId, error: e.message });
    await pool.query(`UPDATE webhook_events SET status='failed', error=$2, updated_at=now() WHERE event_id=$1`, [eventId, e.message.slice(0, 500)]).catch(() => {});
    // Non-2xx so the sender retries; ingest is idempotent so a retry is safe.
    return res.status(500).json({ error: 'Could not process message, please retry' });
  }
});

app.use(express.json({ limit: '50kb' }));

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

/* ----------------------------------------------------------- customer view */
// Test tool: no sign-in, a customer is identified by id. Not suitable for real customers.

app.post('/api/customer/messages', async (req, res, next) => {
  try {
    const name = clean(req.body?.customer?.name);
    const phone = clean(req.body?.customer?.phone);
    const text = clean(req.body?.text);
    if (!name || !PHONE_RE.test(phone)) return bad(res, 'A name and a valid phone number are required');
    if (!text) return bad(res, 'Message is empty');
    if (text.length > config.maxMessageChars) return bad(res, `Message is longer than ${config.maxMessageChars} characters`);
    // Same phone => same customer.
    const id = clean(req.body?.customer?.id) || `cust_${crypto.createHash('sha1').update(phone).digest('hex').slice(0, 10)}`;
    const out = await ingestCustomerMessage({
      brandId: config.brandId,
      customer: { id, name, phone },
      message: { id: `web_${crypto.randomUUID()}`, text },
    });
    res.status(201).json({ customerId: id, conversationId: out.conversationId });
  } catch (e) { next(e); }
});

app.get('/api/customer/:customerId/conversation', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.sender, m.text, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.brand_id=$1 AND c.customer_id=$2 AND c.status='open' ORDER BY m.id`,
      [config.brandId, req.params.customerId],
    ); // drafts are never selected here
    res.json({ messages: rows });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- agent view */

app.post('/api/auth/login', loginRateLimit, async (req, res, next) => {
  try {
    const token = await login(req.body?.email, req.body?.password);
    if (!token) return res.status(401).json({ error: 'Wrong email or password' });
    res.json({ token });
  } catch (e) { next(e); }
});

const agentApi = express.Router();
agentApi.use(requireAgent);

agentApi.get('/conversations', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.last_message_at, cu.name AS customer_name, cu.phone,
              lm.text AS last_text, lm.sender AS last_sender,
              d.status AS draft_status, d.needs_human
       FROM conversations c
       JOIN customers cu ON cu.brand_id=c.brand_id AND cu.id=c.customer_id
       LEFT JOIN LATERAL (SELECT text, sender FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) lm ON true
       LEFT JOIN LATERAL (SELECT status, needs_human FROM drafts WHERE conversation_id=c.id AND status IN ('pending','generating','ready','failed') ORDER BY id DESC LIMIT 1) d ON true
       WHERE c.brand_id=$1 AND c.status='open'
       ORDER BY c.last_message_at DESC LIMIT 200`,
      [req.agent.brandId],
    );
    res.json({ conversations: rows });
  } catch (e) { next(e); }
});

agentApi.get('/conversations/:id', async (req, res, next) => {
  try {
    const { rows: [conv] } = await pool.query(
      `SELECT c.id, cu.name AS customer_name, cu.phone
       FROM conversations c JOIN customers cu ON cu.brand_id=c.brand_id AND cu.id=c.customer_id
       WHERE c.id=$1 AND c.brand_id=$2`,
      [req.params.id, req.agent.brandId],
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const { rows: messages } = await pool.query(
      `SELECT id, sender, text, created_at FROM messages WHERE conversation_id=$1 ORDER BY id`, [conv.id]);
    const { rows: [draft] } = await pool.query(
      `SELECT id, message_id, status, text, needs_human, reason, error FROM drafts
       WHERE conversation_id=$1 AND status IN ('pending','generating','ready','failed') ORDER BY id DESC LIMIT 1`,
      [conv.id],
    );
    res.json({ conversation: conv, messages, draft: draft || null });
  } catch (e) { next(e); }
});

agentApi.post('/drafts/:id/approve', async (req, res, next) => {
  try {
    const text = clean(req.body?.text);
    if (!text) return bad(res, 'Reply is empty');
    if (text.length > config.maxMessageChars) return bad(res, `Reply is longer than ${config.maxMessageChars} characters`);

    const result = await tx(async (db) => {
      const { rows: [d] } = await db.query(
        `SELECT d.*, c.brand_id FROM drafts d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=$1 FOR UPDATE OF d`,
        [req.params.id],
      );
      if (!d || d.brand_id !== req.agent.brandId) return { code: 404 };
      if (d.status === 'used' || d.status === 'superseded') return { code: 409 }; // double-click or two agents
      const { rows: [msg] } = await db.query(
        `INSERT INTO messages (conversation_id, sender, text) VALUES ($1,'agent',$2) RETURNING id, sender, text, created_at`,
        [d.conversation_id, text],
      );
      await db.query(
        `UPDATE drafts SET status='used', edited = (text IS DISTINCT FROM $2), text = COALESCE(text,$2),
                sent_message_id=$3, updated_at=now() WHERE id=$1`,
        [d.id, text, msg.id],
      );
      // Older unused drafts in this conversation are now stale.
      await db.query(
        `UPDATE drafts SET status='superseded', updated_at=now()
         WHERE conversation_id=$1 AND id < $2 AND status IN ('pending','generating','ready','failed')`,
        [d.conversation_id, d.id],
      );
      await db.query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [d.conversation_id]);
      return { code: 200, message: msg };
    });
    if (result.code === 404) return res.status(404).json({ error: 'Draft not found' });
    if (result.code === 409) return res.status(409).json({ error: 'This draft was already approved' });
    res.json({ message: result.message });
  } catch (e) { next(e); }
});

agentApi.post('/drafts/:id/regenerate', async (req, res, next) => {
  try {
    const { rows: [d] } = await pool.query(
      `SELECT d.id FROM drafts d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=$1 AND c.brand_id=$2`,
      [req.params.id, req.agent.brandId]);
    if (!d) return res.status(404).json({ error: 'Draft not found' });
    const ok = await regenerateDraft(d.id);
    res.status(ok ? 202 : 409).json({ ok });
  } catch (e) { next(e); }
});

app.use('/api/agent', agentApi);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------------------------------------------------------- static client */
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log('error', 'unhandled error', { path: req.path, error: err.message });
  res.status(500).json({ error: 'Something went wrong' });
});
