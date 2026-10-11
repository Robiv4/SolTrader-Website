'use client';

import { AlertTriangle, ChevronDown, ExternalLink, LogOut, RefreshCw, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { CopyButton, shortAddress, StatusBadge } from '../primitives';

import { useWallet } from './wallet-context';
import { explorerUrl, NETWORK_LABELS } from './wallet-standard';

export function formatSol(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('hu-HU', { maximumFractionDigits: value >= 100 ? 2 : 4 })} SOL`;
}

function relative(iso: string | null | undefined) {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} mp-e`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} perce`;
  return new Date(iso).toLocaleString('hu-HU');
}

/**
 * Top-right wallet control. Not connected: "Tárca csatlakoztatása". Connected: on-chain SOL balance of the verified
 * address (never the PAPER balance) + short address; the menu shows details, top holdings and the actions.
 */
export function WalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const root = useRef<globalThis.HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: globalThis.Event) => {
      if (event instanceof globalThis.KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as globalThis.Node)) {
        setOpen(false);
        setConfirmDisconnect(false);
      }
    };
    globalThis.document.addEventListener('mousedown', close);
    globalThis.document.addEventListener('keydown', close);
    return () => {
      globalThis.document.removeEventListener('mousedown', close);
      globalThis.document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (wallet.loading) return <span className="wallet-btn skeleton-btn" aria-hidden="true" />;
  if (!wallet.connected || !wallet.wallet?.publicAddress) {
    return <button type="button" className="wallet-btn connect" onClick={wallet.openModal}><Wallet size={16} aria-hidden="true" /><span className="wallet-btn-label">Tárca csatlakoztatása</span></button>;
  }

  const linked = wallet.wallet;
  const address = linked.publicAddress!;
  const balance = wallet.portfolio?.sol.balance ?? linked.lastBalance;
  const network = NETWORK_LABELS[linked.network] ?? linked.network;
  const stale = wallet.rpcError || !wallet.portfolio;
  const top = (wallet.portfolio?.tokens ?? []).slice(0, 3);

  return <div className="wallet-menu" ref={root}>
    <button type="button" className={`wallet-btn connected${wallet.accountMismatch ? ' warn' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
      title={`${linked.label} · ${address}`}>
      <span className={`conn-dot ${wallet.accountMismatch ? 'warn' : stale ? 'stale' : 'live'}`} aria-hidden="true" />
      <strong className="wallet-btn-balance">{formatSol(balance)}</strong>
      <span className="wallet-btn-address">{shortAddress(address)}</span>
      {linked.network !== 'mainnet-beta' ? <span className="badge badge-warning">{network}</span> : null}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open ? <div className="wallet-dropdown" role="menu">
      <div className="wallet-dropdown-head">
        <div><strong>{linked.label}</strong><small>{linked.provider ?? 'Wallet'} · {network}</small></div>
        <StatusBadge tone={wallet.accountMismatch ? 'warning' : stale ? 'neutral' : 'positive'} dot>{wallet.accountMismatch ? 'Fiókváltás' : stale ? 'Nem friss' : 'Ellenőrzött'}</StatusBadge>
      </div>
      {wallet.accountMismatch ? <p className="notice notice-warning"><AlertTriangle size={14} aria-hidden="true" /> A walletben másik fiók aktív ({shortAddress(wallet.accountMismatch)}). Az itt látható adatok az ellenőrzött címhez tartoznak. <button type="button" className="link-btn" onClick={() => { setOpen(false); void wallet.reverify(); }}>Új cím igazolása</button></p> : null}
      <div className="wallet-dropdown-address"><code title={address}>{address}</code><CopyButton text={address} label="Cím másolása" compact /></div>
      <div className="wallet-dropdown-balance"><span>SOL egyenleg</span><strong>{formatSol(balance)}</strong>{wallet.portfolio?.sol.valueUsd != null ? <small>≈ ${wallet.portfolio.sol.valueUsd.toLocaleString('hu-HU', { maximumFractionDigits: 2 })}</small> : null}</div>
      {top.length ? <ul className="wallet-dropdown-tokens">{top.map((token) => <li key={token.mint}><span>{token.symbol ?? shortAddress(token.mint)}</span><span className="mono">{Number(token.amount).toLocaleString('hu-HU', { maximumFractionDigits: 4 })}</span></li>)}</ul> : null}
      {(wallet.portfolio?.tokens.length ?? 0) > 3 ? <small className="muted">+{(wallet.portfolio?.tokens.length ?? 0) - 3} további token</small> : null}
      <small className="muted">Utolsó frissítés: {relative(wallet.portfolio?.fetchedAt ?? linked.lastBalanceAt)}{wallet.rpcError ? ' · RPC nem elérhető' : ''}</small>
      <div className="wallet-dropdown-actions">
        <Link role="menuitem" href="/wallet" className="menu-item" onClick={() => setOpen(false)}><Wallet size={15} aria-hidden="true" /> Tárca megnyitása</Link>
        <button role="menuitem" type="button" className="menu-item" disabled={wallet.refreshing} onClick={() => void wallet.reload(true)}><RefreshCw size={15} className={wallet.refreshing ? 'spin' : ''} aria-hidden="true" /> Egyenleg frissítése</button>
        <a role="menuitem" className="menu-item" href={explorerUrl(address, linked.network)} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} aria-hidden="true" /> Megnyitás a Solscanen</a>
        {confirmDisconnect
          ? <div className="menu-confirm"><span>Biztosan leválasztod?</span><button type="button" className="danger-button small" onClick={() => { setOpen(false); setConfirmDisconnect(false); void wallet.disconnect(); }}>Leválasztás</button><button type="button" className="secondary-button small" onClick={() => setConfirmDisconnect(false)}>Mégse</button></div>
          : <button role="menuitem" type="button" className="menu-item danger" onClick={() => setConfirmDisconnect(true)}><LogOut size={15} aria-hidden="true" /> Tárca leválasztása</button>}
      </div>
    </div> : null}
  </div>;
}
