import { useState } from 'react';
import { api, fmtTime } from './api.js';
import { usePolling } from './usePolling.js';

const TEST_CUSTOMERS = [
  { id: 'cust_1042', name: 'Aisha Khan', phone: '+919800000001' },
  { id: 'cust_1043', name: 'Rohan Mehta', phone: '+919800000002' },
  { id: 'cust_1044', name: 'Priya Nair', phone: '+919800000003' },
];
const SAMPLES = [
  "Hi, my order #4471 hasn't arrived yet. Can I change the delivery address?",
  'What is your return policy?',
  'Do you deliver to Dubai?',
  'Is cash on delivery available for a ₹3,500 order?',
  "I think I'm allergic to the serum I bought. What should I do?",
];

export default function CustomerView() {
  const [pick, setPick] = useState(TEST_CUSTOMERS[0].id);
  const [custom, setCustom] = useState({ name: '', phone: '' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [customerId, setCustomerId] = useState(TEST_CUSTOMERS[0].id);

  const isCustom = pick === 'custom';
  const customer = isCustom ? { name: custom.name.trim(), phone: custom.phone.trim() } : TEST_CUSTOMERS.find((c) => c.id === pick);

  const { data, error: pollError } = usePolling(
    () => api(`/api/customer/${customerId}/conversation`), 3000, [customerId]);

  function choose(value) {
    setPick(value);
    setError('');
    if (value !== 'custom') setCustomerId(value);
  }

  async function send(e) {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true); setError('');
    try {
      const res = await api('/api/customer/messages', { method: 'POST', body: { customer, text } });
      setCustomerId(res.customerId);
      setText('');
    } catch (err) {
      setError(err.message); // keep the typed text so nothing is lost
    } finally { setSending(false); }
  }

  return (
    <section className="card chat">
      <div className="row">
        <label>Test customer
          <select value={pick} onChange={(e) => choose(e.target.value)}>
            {TEST_CUSTOMERS.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>)}
            <option value="custom">Someone else…</option>
          </select>
        </label>
        {isCustom && (
          <>
            <label>Name<input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></label>
            <label>Phone<input placeholder="+919800000000" value={custom.phone} onChange={(e) => setCustom({ ...custom, phone: e.target.value })} /></label>
          </>
        )}
      </div>

      <div className="thread" aria-live="polite">
        {!data?.messages?.length && <p className="muted">No messages yet. Send one below.</p>}
        {data?.messages?.map((m) => (
          <div key={m.id} className={`bubble ${m.sender === 'customer' ? 'mine' : 'theirs'}`}>
            <div>{m.text}</div>
            <small>{m.sender === 'agent' ? 'Verdant & Co' : 'You'} · {fmtTime(m.created_at)}</small>
          </div>
        ))}
      </div>
      {pollError && <p className="error">Cannot refresh the conversation: {pollError.message}</p>}

      <div className="chips">
        {SAMPLES.map((s) => <button key={s} type="button" className="chip" onClick={() => setText(s)}>{s}</button>)}
      </div>
      <form onSubmit={send} className="composer">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" maxLength={2000} rows={2} />
        <button disabled={sending || !text.trim() || (isCustom && (!custom.name.trim() || !custom.phone.trim()))}>{sending ? 'Sending…' : 'Send'}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
