'use client';

import { AlertTriangle, ExternalLink, LogOut, RefreshCw, ShieldCheck, Wallet as WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { fmt, useApi } from '../components';
import { CopyButton, FilterBar, formatCompactUsd, formatTokenPrice, shortAddress, SkeletonRows, StatusBadge } from '../ui/primitives';
import { formatSol } from '../ui/wallet/wallet-button';
import { type TokenHolding, useWallet } from '../ui/wallet/wallet-context';
import { explorerUrl, NETWORK_LABELS } from '../ui/wallet/wallet-standard';
import { BotWalletPanel } from '../wallet-connect';

type SortKey = 'value' | 'amount' | 'symbol';

function amountText(token: TokenHolding) {
  const value = Number(token.amount);
  // The exact decimal string stays available as the title; the cell shows a readable rounding.
  return Number.isFinite(value) ? value.toLocaleString('hu-HU', { maximumFractionDigits: Math.min(6, token.decimals) }) : token.amount;
}

function NotConnected() {
  const { openModal } = useWallet();
  return <section className="wallet-empty">
    <span className="wallet-empty-icon" aria-hidden="true"><WalletIcon size={28} /></span>
    <h2>Csatlakoztasd a Solana tárcádat</h2>
    <p>Lásd egy helyen a SOL-egyenlegedet és az SPL-tokenjeidet. A kapcsolat csak olvasásra szól.</p>
    <button type="button" className="primary-button" onClick={openModal}>Tárca csatlakoztatása</button>
    <ul className="wallet-empty-points">
      <li><ShieldCheck size={16} aria-hidden="true" /> Soha nem kérünk seed phrase-t vagy privát kulcsot.</li>
      <li><ShieldCheck size={16} aria-hidden="true" /> A tulajdonjogot egy díjmentes, egyszer használatos üzenet aláírása igazolja – nem tranzakció.</li>
      <li><ShieldCheck size={16} aria-hidden="true" /> Csak a nyilvános címet tároljuk. A tárca nem kap kereskedési jogosultságot, és nem kapcsol be LIVE kereskedést.</li>
    </ul>
    <small className="muted">Támogatott: Phantom, Solflare, Backpack és más Wallet Standard-kompatibilis Solana tárcák.</small>
  </section>;
}

function Holdings({ tokens }: { tokens: TokenHolding[] }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('value');
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? tokens.filter((token) => [token.symbol, token.name, token.mint].some((value) => value?.toLowerCase().includes(needle))) : tokens;
    return [...filtered].sort((a, b) => {
      if (sort === 'symbol') return (a.symbol ?? a.mint).localeCompare(b.symbol ?? b.mint);
      if (sort === 'amount') return Number(b.amount) - Number(a.amount);
      return (b.valueUsd ?? -1) - (a.valueUsd ?? -1);
    });
  }, [tokens, query, sort]);
  return <section className="tcard">
    <header className="tcard-head"><h2>Tokenállomány</h2><span className="muted">{tokens.length} token</span></header>
    <FilterBar query={query} onQuery={setQuery} placeholder="Keresés: szimbólum, név vagy mint cím" chips={[{ id: 'value', label: 'Érték szerint' }, { id: 'amount', label: 'Mennyiség szerint' }, { id: 'symbol', label: 'Név szerint' }]} activeChip={sort} onChip={(id) => setSort(id as SortKey)} />
    {rows.length === 0 ? <p className="muted empty-line">{tokens.length ? 'Nincs találat.' : 'Ezen a címen nincs SPL-token.'}</p> : <div className="holdings-table" role="table" aria-label="Tokenállomány">
      <div className="holdings-row head" role="row"><span role="columnheader">Token</span><span role="columnheader">Mennyiség</span><span role="columnheader">Ár</span><span role="columnheader">Becsült érték</span></div>
      {rows.map((token) => <div className="holdings-row" role="row" key={token.mint}>
        <span role="cell" className="holdings-token">
          <strong>{token.symbol ?? 'Ismeretlen token'}</strong>
          <small><span className="mono" title={token.mint}>{shortAddress(token.mint, 6, 6)}</span><CopyButton text={token.mint} label="Mint cím másolása" compact />{token.program === 'spl-token-2022' ? <StatusBadge tone="info">Token-2022</StatusBadge> : null}</small>
          {token.name ? <small className="muted">{token.name}</small> : null}
        </span>
        <span role="cell" className="mono" title={`${token.amount} (tizedesjegyek: ${token.decimals})`}>{amountText(token)}</span>
        <span role="cell" className="mono">{token.priceUsd == null ? <span className="muted">Nem elérhető</span> : formatTokenPrice(token.priceUsd)}</span>
        <span role="cell" className="mono">{token.valueUsd == null ? <span className="muted">Nem elérhető</span> : formatCompactUsd(token.valueUsd)}</span>
      </div>)}
    </div>}
    <p className="muted small-print">USD-érték csak friss, megbízható árforrásból jelenik meg (SolTrader piaci adat vagy a piaci adatszolgáltató); ár hiányában „Nem elérhető”. A rendszer nem becsül és nem talál ki árat.</p>
  </section>;
}

export default function WalletPage() {
  const wallet = useWallet();
  const { data: me } = useApi<{ data: { role: string } }>('/api/auth/me');
  const { data: paper } = useApi<{ data: { equity: number | null; cashBalance: number | null } }>('/api/paper-account');
  const [confirm, setConfirm] = useState(false);
  const isAdmin = me?.data?.role === 'ADMIN';

  if (wallet.loading) return <section className="tcard"><SkeletonRows rows={5} /></section>;

  const linked = wallet.wallet;
  const portfolio = wallet.portfolio;
  return <div className="wallet-page">
    {!wallet.connected || !linked?.publicAddress ? <NotConnected /> : <>
      {wallet.accountMismatch ? <p className="notice notice-warning"><AlertTriangle size={16} aria-hidden="true" /> A walletben jelenleg másik fiók aktív ({shortAddress(wallet.accountMismatch)}). Az oldal az ellenőrzött címet mutatja. <button type="button" className="link-btn" onClick={() => void wallet.reverify()}>Új cím igazolása aláírással</button></p> : null}
      {wallet.rpcError ? <p className="notice notice-warning"><AlertTriangle size={16} aria-hidden="true" /> Az RPC most nem elérhető; az utoljára tárolt SOL-egyenleg látszik. Próbáld később.</p> : null}
      <section className="wallet-hero">
        <div className="wallet-hero-id">
          <span className="wallet-hero-icon" aria-hidden="true"><WalletIcon size={22} /></span>
          <div>
            <div className="wallet-hero-title"><strong>{linked.label}</strong><StatusBadge tone="positive" dot>Ellenőrzött</StatusBadge><StatusBadge tone={linked.network === 'mainnet-beta' ? 'neutral' : 'warning'}>{NETWORK_LABELS[linked.network] ?? linked.network}</StatusBadge></div>
            <div className="wallet-hero-address"><code title={linked.publicAddress}>{linked.publicAddress}</code><CopyButton text={linked.publicAddress} label="Cím másolása" compact /></div>
            <small className="muted">{linked.provider ?? 'Wallet'} · utolsó frissítés: {portfolio?.fetchedAt ? new Date(portfolio.fetchedAt).toLocaleString('hu-HU') : linked.lastBalanceAt ? new Date(linked.lastBalanceAt).toLocaleString('hu-HU') : '—'}{wallet.refreshThrottled ? ' · a frissítés 15 mp-enként kérhető' : ''}</small>
          </div>
        </div>
        <div className="wallet-hero-actions">
          <button type="button" className="secondary-button" disabled={wallet.refreshing} onClick={() => void wallet.reload(true)}><RefreshCw size={15} className={wallet.refreshing ? 'spin' : ''} aria-hidden="true" /> Frissítés</button>
          <a className="secondary-button" href={explorerUrl(linked.publicAddress, linked.network)} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} aria-hidden="true" /> Solscan</a>
          {confirm
            ? <><button type="button" className="danger-button" onClick={() => { setConfirm(false); void wallet.disconnect(); }}>Leválasztás megerősítése</button><button type="button" className="secondary-button" onClick={() => setConfirm(false)}>Mégse</button></>
            : <button type="button" className="secondary-button" onClick={() => setConfirm(true)}><LogOut size={15} aria-hidden="true" /> Leválasztás</button>}
        </div>
      </section>

      <section className="wallet-stats">
        <div className="wallet-stat primary"><span>SOL egyenleg (on-chain)</span><strong>{formatSol(portfolio?.sol.balance ?? linked.lastBalance)}</strong><small>{portfolio?.sol.valueUsd != null ? `≈ ${formatCompactUsd(portfolio.sol.valueUsd)}` : linked.network !== 'mainnet-beta' ? 'teszthálózat: nincs USD-érték' : 'USD-érték nem elérhető'}</small></div>
        <div className="wallet-stat"><span>Becsült portfólióérték</span><strong>{portfolio?.totalUsd != null ? formatCompactUsd(portfolio.totalUsd) : 'Nem számolható'}</strong><small>{portfolio ? (portfolio.totalUsd != null ? 'minden tételnek van ára' : `${portfolio.unpricedTokens} token ára nem elérhető`) : '—'}</small></div>
        <div className="wallet-stat"><span>SPL-tokenek</span><strong>{portfolio ? portfolio.tokens.length : '—'}</strong><small>{portfolio ? `${portfolio.pricedTokens} árazott` : '—'}</small></div>
      </section>

      {portfolio ? <Holdings tokens={portfolio.tokens} /> : <section className="tcard"><p className="muted">A tokenállomány most nem tölthető be.</p></section>}
    </>}

    <section className="wallet-separation">
      <div className="sep-card"><span className="badge badge-brand">Saját tárca</span><p>Böngészős wallet, a te tulajdonod. On-chain, csak olvasva jelenik meg; a bot nem használja.</p></div>
      <div className="sep-card"><span className="badge badge-neutral">PAPER számla</span><p>Szimulált kereskedési egyenleg: <strong>{paper?.data?.equity != null ? `${fmt(paper.data.equity)} USDC` : '—'}</strong>. Nem valódi pénz, nem azonos a tárca egyenlegével. <Link href="/settings#bot" className="link-btn">Kezelés</Link></p></div>
      <div className="sep-card"><span className="badge badge-warning">Bot kereskedő tárca</span><p>Külön adminisztrációs beállítás (lent). LIVE kereskedés tiltva.</p></div>
    </section>

    <details className="tcard admin-section">
      <summary>Haladó: bot kereskedő tárca {isAdmin ? '' : '(csak olvasás)'}</summary>
      <BotWalletPanel isAdmin={isAdmin} />
    </details>
  </div>;
}
