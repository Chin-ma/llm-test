import { useState } from 'react';
import CustomerView from './CustomerView.jsx';
import AgentView from './AgentView.jsx';

export default function App() {
  const [mode, setMode] = useState('customer');
  return (
    <div className="app">
      <header className="topbar">
        <strong>Verdant &amp; Co · Support</strong>
        <div className="toggle" role="tablist" aria-label="View">
          {['customer', 'agent'].map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m === 'customer' ? 'Customer' : 'Agent'}
            </button>
          ))}
        </div>
      </header>
      <main>{mode === 'customer' ? <CustomerView /> : <AgentView />}</main>
    </div>
  );
}
