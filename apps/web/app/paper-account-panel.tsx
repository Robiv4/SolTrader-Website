'use client';

import { useState } from 'react';

import { apiRequest, fmt, Metric, Panel, useApi } from './components';

type PaperAccount = { initialBalance: number | null; cashBalance: number | null; equity: number | null; realizedPnl: number | null; unrealizedPnl: number | null; totalFees: number | null };

/** Paper account balances and a reset to a fresh starting balance. */
export function PaperAccountPanel() {
  const { data, error, refresh } = useApi<{ data: PaperAccount }>('/api/paper-account');
  const [balance, setBalance] = useState('1000');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const account = data?.data;

  const reset = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest('/api/paper-account/reset', { method: 'POST', body: JSON.stringify({ initialBalance: Number(balance) }) });
      setMessage({ text: `A Paper számla visszaállítva ${fmt(Number(balance))} USDC kezdőtőkére.`, tone: 'success' });
      setConfirming(false);
      refresh();
    } catch (resetError) {
      setMessage({ text: resetError instanceof Error ? resetError.message : 'A visszaállítás sikertelen', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return <Panel title="Paper számla">
    {message && <p className={`wallet-message ${message.tone}`} role="status">{message.text}</p>}
    {error && !account ? <p className="wallet-message error">{error}</p> : <div className="metric-grid compact">
      <Metric label="Kezdőtőke" value={`${fmt(account?.initialBalance)} USDC`} />
      <Metric label="Szabad egyenleg" value={`${fmt(account?.cashBalance)} USDC`} />
      <Metric label="Teljes érték" value={`${fmt(account?.equity)} USDC`} />
      <Metric label="Befizetett díjak" value={fmt(account?.totalFees)} />
    </div>}
    <div className="field-grid" style={{ marginTop: 18 }}>
      <label>Új kezdőtőke (USDC)<input type="number" min="1" step="100" value={balance} onChange={(event) => setBalance(event.target.value)} /></label>
    </div>
    {confirming
      ? <div className="row-inline"><span className="annotation" style={{ margin: 0 }}>A számla egyenlege és P&amp;L-je nullázódik. A kereskedési előzmények megmaradnak.</span><div className="header-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirming(false)}>Mégse</button><button type="button" className="danger-button" disabled={busy || !(Number(balance) > 0)} onClick={() => void reset()}>{busy ? 'Visszaállítás…' : 'Visszaállítás megerősítése'}</button></div></div>
      : <button type="button" className="secondary-button" disabled={!(Number(balance) > 0)} onClick={() => setConfirming(true)}>Paper számla visszaállítása</button>}
    <p className="annotation">Csak akkor állítható vissza, ha nincs nyitott Paper pozíció.</p>
  </Panel>;
}
