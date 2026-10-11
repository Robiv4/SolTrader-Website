'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiRequest, date, fmt } from './components';
import { StatusBadge } from './ui/primitives';

export type WalletSummary = {
  id: string | null;
  type: 'USER' | 'BOT_TRADING';
  publicAddress: string | null;
  network: string;
  label: string;
  provider: string | null;
  isActive: boolean;
  status: string;
  connected: boolean;
  configured: boolean;
  lastBalance: number | null;
  lastBalanceAt: string | null;
};

export type WalletResponse = { userWallet: WalletSummary; botTradingWallet: WalletSummary; wallets: WalletSummary[] };

type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

/**
 * Bot trading wallet (administrators only). Separate from the browser wallet: only its PUBLIC address is registered;
 * the signing secret stays in server-side secret management (BOT_TRADING_WALLET_SECRET) and never reaches the browser.
 * LIVE trading stays disabled; registering an address enables nothing.
 */
export function BotWalletPanel({ isAdmin }: { isAdmin: boolean }) {
  const [state, setState] = useState<WalletResponse | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'neutral' | 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState<SolanaNetwork>('mainnet-beta');

  const load = useCallback(async () => {
    try {
      const response = await apiRequest<{ data: WalletResponse }>('/api/settings/wallet');
      setState(response.data);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'A bot tárca adatai nem tölthetők be.', tone: 'error' });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (request: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await request();
      setMessage({ text: done, tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'A művelet sikertelen.', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const bot = state?.botTradingWallet;
  return <div className="bot-wallet">
    {message ? <p className={`notice ${message.tone === 'error' ? 'notice-negative' : message.tone === 'success' ? 'notice-positive' : 'notice-info'}`} role="status">{message.text}</p> : null}
    <div className="bot-wallet-row">
      <div>
        <strong>Bot kereskedő tárca</strong>
        <code className="bot-wallet-address">{bot?.publicAddress ?? 'Nincs beállítva'}</code>
        {bot?.connected ? <small className="muted">Egyenleg: {bot.lastBalance == null ? 'Nem elérhető' : `${fmt(bot.lastBalance, 6)} SOL`}{bot.lastBalanceAt ? ` · ${date(bot.lastBalanceAt)}` : ''}</small> : null}
      </div>
      <StatusBadge tone={bot?.connected ? 'positive' : 'neutral'}>{bot?.connected ? 'BEÁLLÍTVA' : 'NINCS BEÁLLÍTVA'}</StatusBadge>
    </div>
    {isAdmin ? (bot?.connected
      ? <button type="button" className="secondary-button small" disabled={busy} onClick={() => void run(() => apiRequest('/api/settings/wallet/disconnect', { method: 'POST', body: JSON.stringify({ type: 'BOT_TRADING' }) }), 'A bot kereskedő tárca eltávolítva.')}>Eltávolítás</button>
      : <div className="bot-wallet-form">
        <label>Nyilvános cím<input type="text" placeholder="Solana nyilvános cím" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <label>Hálózat<select value={network} onChange={(event) => setNetwork(event.target.value as SolanaNetwork)}><option value="mainnet-beta">Mainnet</option><option value="devnet">Devnet</option><option value="testnet">Testnet</option></select></label>
        <button type="button" className="secondary-button" disabled={busy || address.trim().length < 32} onClick={() => void run(async () => {
          await apiRequest('/api/settings/wallet/connect', { method: 'POST', body: JSON.stringify({ type: 'BOT_TRADING', publicAddress: address.trim(), network, provider: 'OTHER', label: 'Bot trading wallet' }) });
          setAddress('');
        }, 'A bot kereskedő tárca címe mentve.')}>Cím mentése</button>
      </div>) : <p className="muted" style={{ margin: 0 }}>Bot tárcát csak adminisztrátor állíthat be.</p>}
    <p className="muted bot-wallet-note">Csak nyilvános cím. A bot privát kulcsa a szerver titokkezelésében van, soha nem a böngészőben. A LIVE kereskedés tiltva marad; egy cím megadása semmit nem kapcsol be.</p>
  </div>;
}
