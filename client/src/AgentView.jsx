import { useState } from 'react';
import { api, getToken, setToken, fmtTime } from './api.js';
import { usePolling } from './usePolling.js';

export default function AgentView() {
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  const [selected, setSelected] = useState(null);

  const signOut = () => { setToken(null); setSignedIn(false); setSelected(null); };
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;

  return (
    <div className="agent">
      <aside className="card list">
        <div className="list-head"><strong>Conversations</strong><button className="link" onClick={signOut}>Sign out</button></div>
        <ConversationList selected={selected} onSelect={setSelected} onExpired={signOut} />
      </aside>
      <section className="card detail">
        {selected ? <Conversation key={selected} id={selected} onExpired={signOut} /> : <p className="muted">Select a conversation.</p>}
      </section>
    </div>
  );
}

function Login({ onDone }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { const { token } = await api('/api/auth/login', { method: 'POST', body: form }); setToken(token); onDone(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="card login" onSubmit={submit}>
      <h2>Agent sign in</h2>
      <label>Email<input type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
      <label>Password<input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function ConversationList({ selected, onSelect, onExpired }) {
  const { data, error } = usePolling(async () => {
    try { return await api('/api/agent/conversations', { auth: true }); }
    catch (e) { if (e.status === 401) onExpired(); throw e; }
  }, 4000);
  if (!data && !error) return <p className="muted">Loading…</p>;
  return (
    <>
      {error && <p className="error">Cannot refresh: {error.message}</p>}
      {data?.conversations.length === 0 && <p className="muted">No conversations yet.</p>}
      <ul>
        {data?.conversations.map((c) => (
          <li key={c.id}>
            <button className={`conv ${selected === c.id ? 'on' : ''}`} onClick={() => onSelect(c.id)}>
              <span className="conv-top"><strong>{c.customer_name}</strong><small>{fmtTime(c.last_message_at)}</small></span>
              <span className="preview">{c.last_sender === 'agent' ? 'You: ' : ''}{c.last_text}</span>
              {c.draft_status && <span className={`tag ${c.needs_human ? 'warn' : ''}`}>{c.needs_human ? 'Needs a human look' : c.draft_status === 'ready' ? 'Draft ready' : c.draft_status === 'failed' ? 'Write manually' : 'Drafting…'}</span>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Conversation({ id, onExpired }) {
  const { data, error, refresh } = usePolling(async () => {
    try { return await api(`/api/agent/conversations/${id}`, { auth: true }); }
    catch (e) { if (e.status === 401) onExpired(); throw e; }
  }, 3000);

  // Keep the agent's edits when the poll brings a new draft text for the same draft.
  const [edits, setEdits] = useState({}); // draftId -> text
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if (!data) return error ? <p className="error">{error.message}</p> : <p className="muted">Loading…</p>;
  const { conversation, messages, draft } = data;
  const value = draft ? (edits[draft.id] ?? draft.text ?? '') : '';

  async function approve() {
    setBusy(true); setMsg('');
    try {
      await api(`/api/agent/drafts/${draft.id}/approve`, { method: 'POST', auth: true, body: { text: value } });
      setEdits({}); await refresh();
    } catch (e) {
      setMsg(e.status === 409 ? 'Already approved elsewhere. Refreshing…' : e.message);
      if (e.status === 409) await refresh();
    } finally { setBusy(false); }
  }
  async function regenerate() {
    setBusy(true); setMsg('');
    try { await api(`/api/agent/drafts/${draft.id}/regenerate`, { method: 'POST', auth: true }); setEdits({}); await refresh(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <h2>{conversation.customer_name} <small className="muted">{conversation.phone}</small></h2>
      {error && <p className="error">Cannot refresh: {error.message}</p>}
      <div className="thread">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.sender === 'customer' ? 'theirs' : 'mine'}`}>
            <div>{m.text}</div><small>{m.sender === 'agent' ? 'Agent' : conversation.customer_name} · {fmtTime(m.created_at)}</small>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="draft">
          <div className="draft-head">
            <strong>AI suggested reply</strong>
            {draft.status === 'ready' && <button className="link" onClick={regenerate} disabled={busy}>Regenerate</button>}
          </div>
          {draft.needs_human && <p className="banner warn">The AI flagged this for a human look{draft.reason ? `: ${draft.reason}` : '.'} Review carefully before sending.</p>}
          {(draft.status === 'pending' || draft.status === 'generating') && <p className="muted">Drafting a reply… you can also type your own below.</p>}
          {draft.status === 'failed' && (
            <p className="banner warn">The AI draft is unavailable, so please write the reply yourself.{' '}
              <button className="link" onClick={regenerate} disabled={busy}>Try the AI again</button></p>
          )}
          <textarea rows={5} value={value} onChange={(e) => setEdits({ ...edits, [draft.id]: e.target.value })}
            placeholder={draft.status === 'ready' ? '' : 'Type your reply…'} maxLength={2000} />
          <div className="actions">
            <button onClick={approve} disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Approve & send'}</button>
          </div>
          {msg && <p className="error" role="alert">{msg}</p>}
        </div>
      ) : <p className="muted">No reply needed: the latest message has been answered.</p>}
    </>
  );
}
