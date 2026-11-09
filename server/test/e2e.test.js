import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

let pgServer, llm, base, agentToken, appMod, dbMod, draftsMod;
let llmMode = 'ok'; // ok | fail
const llmCalls = [];
const SECRET = 'verdant-demo-secret-2026';

const sign = (body) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const payload = (over = {}) => ({
  event_id: 'evt_' + crypto.randomUUID(), type: 'message.received', brand_id: 'verdant-co',
  timestamp: '2026-11-03T10:15:22Z',
  customer: { id: 'cust_1042', name: 'Aisha Khan', phone: '+919800000001' },
  message: { id: 'msg_' + crypto.randomUUID(), type: 'text', text: 'What is your return policy?' },
  ...over,
});
const post = (body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(base + '/webhook', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-signature': sign(raw), ...headers } });
};
const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.auth ? { authorization: 'Bearer ' + agentToken } : {}) }, body: opts.body && JSON.stringify(opts.body) });
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgtest-'));
  pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: 54329, persistent: false });
  await pgServer.initialise(); await pgServer.start(); await pgServer.createDatabase('verdant');

  llm = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      llmCalls.push(JSON.parse(b));
      if (llmMode === 'fail') { res.statusCode = 500; return res.end('boom'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: '{"reply":"Returns are accepted within 7 days of delivery.","needs_human":false,"reason":"Returns policy"}' } }] }));
    });
  }).listen(0);
  process.env.DATABASE_URL = 'postgres://postgres:pw@localhost:54329/verdant';
  process.env.JWT_SECRET = 'test-secret';
  process.env.AGENT_EMAIL = 'agent@verdant.test'; process.env.AGENT_PASSWORD = 'pass1234';
  process.env.LLM_API_KEY = 'k'; process.env.LLM_BASE_URL = `http://localhost:${llm.address().port}`;
  dbMod = await import('../db.js'); draftsMod = await import('../drafts.js');
  await dbMod.migrate(); await (await import('../auth.js')).seedAgent();
  appMod = await import('../app.js');
  const srv = appMod.app.listen(0); base = `http://localhost:${srv.address().port}`; before.srv = srv;
  agentToken = (await (await api('/api/auth/login', { method: 'POST', body: { email: 'agent@verdant.test', password: 'pass1234' } })).json()).token;
});
after(async () => { before.srv?.close(); llm?.close(); await dbMod?.pool.end(); await pgServer?.stop(); });

test('rejects missing or wrong signature', async () => {
  assert.equal((await post(payload(), { 'x-signature': 'sha256=' + 'a'.repeat(64) })).status, 401);
  assert.equal((await post(payload(), { 'x-signature': 'nope' })).status, 401);
});

test('rejects invalid payloads with 400', async () => {
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(payload({ customer: { id: 'x' } }))).status, 400);
  assert.equal((await post(payload({ brand_id: 'other' }))).status, 400);
});

test('webhook stores message, creates draft, agent sees it, approval reaches customer', async () => {
  const p = payload();
  const r = await post(p);
  assert.equal(r.status, 200);
  const { conversation_id } = await r.json();

  const detail = await waitFor(async () => {
    const d = await (await api(`/api/agent/conversations/${conversation_id}`, { auth: true })).json();
    return d.draft?.status === 'ready' ? d : null;
  });
  assert.equal(detail.messages.length, 1);
  assert.match(detail.draft.text, /7 days/);
  // The KB must be in the prompt, and the customer text sent as a user message.
  assert.match(llmCalls.at(-1).messages[0].content, /Cash on delivery/);
  assert.equal(llmCalls.at(-1).messages.at(-1).role, 'user');

  // customer must not see the draft yet
  let cust = await (await api('/api/customer/cust_1042/conversation')).json();
  assert.equal(cust.messages.length, 1);

  const ap = await api(`/api/agent/drafts/${detail.draft.id}/approve`, { method: 'POST', auth: true, body: { text: 'Edited: returns within 7 days.' } });
  assert.equal(ap.status, 200);
  const again = await api(`/api/agent/drafts/${detail.draft.id}/approve`, { method: 'POST', auth: true, body: { text: 'dup' } });
  assert.equal(again.status, 409);

  cust = await (await api('/api/customer/cust_1042/conversation')).json();
  assert.deepEqual(cust.messages.map((m) => m.sender), ['customer', 'agent']);
  assert.equal(cust.messages[1].text, 'Edited: returns within 7 days.');
  const { rows: [d] } = await dbMod.pool.query('SELECT status, edited FROM drafts WHERE id=$1', [detail.draft.id]);
  assert.deepEqual([d.status, d.edited], ['used', true]);
});

test('duplicate delivery of the same message is idempotent', async () => {
  const p = payload({ customer: { id: 'cust_dup', name: 'Dup', phone: '+919800000009' } });
  assert.equal((await (await post(p)).json()).status, 'accepted');
  assert.equal((await (await post(p)).json()).status, 'duplicate');
  const { rows } = await dbMod.pool.query(`SELECT count(*)::int n FROM messages WHERE external_id=$1`, [p.message.id]);
  assert.equal(rows[0].n, 1);
});

test('one open conversation per customer; new messages append', async () => {
  const c = { id: 'cust_one', name: 'One', phone: '+919800000010' };
  await Promise.all([post(payload({ customer: c })), post(payload({ customer: c })), post(payload({ customer: c }))]);
  const { rows } = await dbMod.pool.query(`SELECT count(*)::int n FROM conversations WHERE customer_id='cust_one' AND status='open'`);
  assert.equal(rows[0].n, 1);
  const { rows: m } = await dbMod.pool.query(`SELECT count(*)::int n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.customer_id='cust_one'`);
  assert.equal(m[0].n, 3);
});

test('LLM failure: message is kept, draft fails after retries, agent can still reply manually', async () => {
  llmMode = 'fail';
  const c = { id: 'cust_fail', name: 'Fail', phone: '+919800000011' };
  const r = await post(payload({ customer: c }));
  assert.equal(r.status, 200); // customer message is never lost because the LLM is down
  const { conversation_id } = await r.json();
  const { rows: [d] } = await dbMod.pool.query('SELECT id FROM drafts WHERE conversation_id=$1', [conversation_id]);
  await waitFor(async () => (await dbMod.pool.query('SELECT attempts FROM drafts WHERE id=$1', [d.id])).rows[0].attempts >= 1);
  // simulate the sweeper retrying until the attempt limit
  for (let i = 0; i < 3; i++) { await dbMod.pool.query(`UPDATE drafts SET updated_at = now() - interval '1 minute' WHERE id=$1 AND status='pending'`, [d.id]); await draftsMod.generateDraft(d.id); }
  const detail = await (await api(`/api/agent/conversations/${conversation_id}`, { auth: true })).json();
  assert.equal(detail.draft.status, 'failed');
  assert.ok(detail.draft.error);
  const ap = await api(`/api/agent/drafts/${d.id}/approve`, { method: 'POST', auth: true, body: { text: 'Typed by hand.' } });
  assert.equal(ap.status, 200);

  // regenerate recovers once the LLM is back
  llmMode = 'ok';
  const r2 = await post(payload({ customer: c }));
  const { rows: [d2] } = await dbMod.pool.query('SELECT id FROM drafts ORDER BY id DESC LIMIT 1');
  await waitFor(async () => (await dbMod.pool.query('SELECT status FROM drafts WHERE id=$1', [d2.id])).rows[0].status === 'ready');
  assert.equal(r2.status, 200);
});

test('agent endpoints need a login; wrong password rejected', async () => {
  assert.equal((await api('/api/agent/conversations')).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'agent@verdant.test', password: 'wrong' } })).status, 401);
  const list = await (await api('/api/agent/conversations', { auth: true })).json();
  assert.ok(list.conversations.length >= 1);
  const times = list.conversations.map((c) => +new Date(c.last_message_at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a)); // newest activity first
});

test('customer view uses the same pipeline', async () => {
  const r = await api('/api/customer/messages', { method: 'POST', body: { customer: { name: 'Test', phone: '+919811111111' }, text: 'Do you deliver to Dubai?' } });
  assert.equal(r.status, 201);
  const { customerId, conversationId } = await r.json();
  await waitFor(async () => (await dbMod.pool.query(`SELECT 1 FROM drafts WHERE conversation_id=$1 AND status='ready'`, [conversationId])).rowCount);
  const c = await (await api(`/api/customer/${customerId}/conversation`)).json();
  assert.equal(c.messages.length, 1);
  assert.equal((await api('/api/customer/messages', { method: 'POST', body: { customer: { name: 'T', phone: 'abc' }, text: 'hi' } })).status, 400);
});
