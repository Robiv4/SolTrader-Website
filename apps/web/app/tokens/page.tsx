'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CheckCircle2, Eye, Radar, Search, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AI_DECISION_LABELS, aiDecisionTone } from '../ai-analysis-panel';
import { TokenAvatar } from '../avatars';
import { apiRequest, DataTable, EmptyState, ErrorState, formatPrice, fmt, LoadingState, PageHeader, Panel, Stacked, Status, useApi } from '../components';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { describeReasons, label, qualityLabel } from '../locales/hu';
import { Kpi } from '../ui-cards';

function riskTone(decision: string | null | undefined) {
  if (decision === 'LOW' || decision === 'MODERATE' || decision === 'ACCEPT') return 'positive';
  if (decision === 'HIGH' || decision === 'VERY_HIGH' || decision === 'WATCH') return 'warning';
  if (decision === 'EXTREME' || decision === 'BLOCKED' || decision === 'REJECT') return 'danger';
  return 'neutral';
}

function directionTone(direction: string | null | undefined) {
  if (direction === 'BUY') return 'positive';
  if (direction === 'SELL') return 'danger';
  if (direction === 'WATCH') return 'warning';
  return 'neutral';
}

type ManualBuyStatus = { status: 'PROCESSING' | 'EXECUTED' | 'REJECTED' | 'BLOCKED' | 'EXPIRED'; reasons?: string[]; notionalUsd?: number | null; feeUsd?: number | null; requestedAmount?: number | null; positionMultiplier?: number | null; riskClassification?: string | null; positionStatus?: string | null; exitReason?: string | null };

function describeExecution(outcome: ManualBuyStatus) {
  const parts = [`Paper vétel végrehajtva: ${fmt(outcome.notionalUsd ?? 0)} USDC levonva a számláról (+ ${fmt(outcome.feeUsd ?? 0, 4)} USDC díj).`];
  if (outcome.requestedAmount != null && outcome.notionalUsd != null && outcome.notionalUsd < outcome.requestedAmount * 0.99) {
    parts.push(outcome.positionMultiplier != null && outcome.positionMultiplier < 1
      ? `A kért ${fmt(outcome.requestedAmount)} USDC-t a kockázatkezelés ${fmt(outcome.positionMultiplier * 100, 0)}%-ra csökkentette (${label(outcome.riskClassification ?? '')} kockázat).`
      : `A kért ${fmt(outcome.requestedAmount)} USDC-t a pozíció- vagy kitettségi limit csökkentette.`);
  }
  if (outcome.positionStatus === 'CLOSED') parts.push(`A pozíció azóta le is zárult (${outcome.exitReason ?? 'kilépés'}) – a Kereskedések oldalon látod.`);
  else parts.push('A pozíció a Pozíciók oldalon látható.');
  return parts.join(' ');
}

export default function TokensPage() {
  const router = useRouter();
  const { data, error, loading, refresh } = useApi<{ data: any[] }>('/api/tokens');
  const scannerSettings = useApi<{ data: { isScannerEnabled?: boolean } }>('/api/settings');
  const scannerOff = scannerSettings.data?.data?.isScannerEnabled === false;
  const { lastEvent } = useRealtimeEvents(['token_update', 'risk_update', 'signal_update', 'decision_update']);
  const [query, setQuery] = useState('');
  const [risk, setRisk] = useState('ALL');
  const [liquidity, setLiquidity] = useState('ALL');
  const [sortBy, setSortBy] = useState<'volume24h' | 'liquidityUsd' | 'marketCap'>('volume24h');
  const [selectedToken, setSelectedToken] = useState<any | null>(null);
  const [amount, setAmount] = useState('5');
  const [amountType, setAmountType] = useState<'USDC' | 'EQUITY_PERCENT'>('USDC');
  const [buyMessage, setBuyMessage] = useState('');
  const [buyTone, setBuyTone] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [buying, setBuying] = useState(false);

  useEffect(() => { if (lastEvent) refresh(); }, [lastEvent, refresh]);

  const manualBuy = async () => {
    if (!selectedToken) return;
    setBuying(true); setBuyMessage(''); setBuyTone('neutral');
    try {
      const request = await apiRequest<{ data: { signalId: string } }>('/api/paper/orders/manual-buy', { method: 'POST', body: JSON.stringify({ tokenAddress: selectedToken.address, requestedAmount: Number(amount), amountType }) });
      setBuyMessage('A kérés elküldve. A worker a következő ciklusban újraellenőrzi a kockázatot és dönt…');
      // The worker decides asynchronously; poll the outcome so the user sees the actual result.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
        const outcome = await apiRequest<{ data: ManualBuyStatus }>(`/api/paper/orders/manual-buy/${request.data.signalId}`);
        if (outcome.data.status === 'EXECUTED') {
          setBuyTone('success');
          setBuyMessage(describeExecution(outcome.data));
          refresh();
          return;
        }
        if (outcome.data.status === 'REJECTED' || outcome.data.status === 'BLOCKED') {
          setBuyTone('error');
          setBuyMessage(`A Paper vételt a kockázatkezelés elutasította: ${describeReasons(outcome.data.reasons ?? [])}.`);
          return;
        }
        if (outcome.data.status === 'EXPIRED') break;
      }
      setBuyTone('error');
      setBuyMessage('A worker nem dolgozta fel a kérést. Ellenőrizd, hogy a bot fut-e (Rendszer → Indítás) és a worker szolgáltatás el van-e indítva.');
    } catch (buyError) {
      setBuyTone('error');
      setBuyMessage(buyError instanceof Error ? buyError.message : 'A Paper vétel sikertelen');
    } finally { setBuying(false); }
  };

  if (loading && !data) return <><PageHeader eyebrow="Piaci adatok" title="Tokenfigyelő" /><LoadingState /></>;
  if (error && !data) return <><PageHeader eyebrow="Piaci adatok" title="Tokenfigyelő" /><ErrorState message={error} /></>;

  const rows = data?.data ?? [];
  const numberValue = (value: any) => {
    const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const visibleRows = rows
    .filter((row: any) => `${row.symbol ?? ''} ${row.name ?? ''} ${row.address ?? ''}`.toLowerCase().includes(query.toLowerCase().trim()))
    .filter((row: any) => risk === 'ALL' || row.riskClassification === risk)
    .filter((row: any) => liquidity === 'ALL' || numberValue(row.liquidityUsd) >= Number(liquidity))
    .sort((left: any, right: any) => numberValue(right[sortBy]) - numberValue(left[sortBy]));

  return <>
    <PageHeader eyebrow="Piaci adatok" title="Tokenfigyelő" subtitle="A scanner által figyelt tokenek kockázati és jelzés-értékeléssel – kattints egy sorra a részletekért" action={scannerOff ? <Status tone="warning">KIKAPCSOLVA</Status> : <Status tone="positive">ÉLŐ ADAT</Status>} />
    {scannerOff ? <p className="settings-warning">A tokenfigyelő ki van kapcsolva: a lista nem frissül és nem keres új tokeneket. <Link href="/settings#scanner">Bekapcsolás a Beállításokban →</Link></p> : null}
    <section className="kpi-grid" aria-label="Tokenfigyelő összefoglaló">
      <Kpi icon={<Radar size={20} />} label="Figyelt tokenek" value={<>{rows.length} <small>db</small></>} note="a scanner forgó listáján" />
      <Kpi icon={<CheckCircle2 size={20} />} label="Vételre alkalmas" value={<span className="positive-value">{rows.filter((row: any) => row.decision === 'APPROVED' || row.decision === 'APPROVED_REDUCED_SIZE').length}</span>} note="a kockázatkezelés jóváhagyta" />
      <Kpi icon={<Eye size={20} />} label="Megfigyelés alatt" value={rows.filter((row: any) => row.decision === 'WATCH').length} note="még nem teljesül minden feltétel" />
      <Kpi icon={<ShieldAlert size={20} />} label="Blokkolt / kihagyott" value={rows.filter((row: any) => row.riskHardBlocked || row.skipped).length} note="kemény tiltás vagy ideiglenes kihagyás" />
    </section>
    <Panel title="Figyelt tokenek" description="Szűrés és rendezés; a Paper vétel gomb csak az ellenőrzésen átment tokeneknél aktív.">
      <div className="scanner-controls">
        <label className="scanner-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Tokenek keresése</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Szimbólum vagy cím keresése" /></label>
        <label>Kockázat<select value={risk} onChange={(event) => setRisk(event.target.value)}><option value="ALL">Minden kockázat</option>{['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH', 'EXTREME', 'BLOCKED'].map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
        <label>Min. likviditás<select value={liquidity} onChange={(event) => setLiquidity(event.target.value)}><option value="ALL">Bármennyi</option><option value="10000">$10k</option><option value="50000">$50k</option><option value="100000">$100k</option></select></label>
        <label>Rendezés<select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}><option value="volume24h">24 órás forgalom</option><option value="liquidityUsd">Likviditás</option><option value="marketCap">Piaci kapitalizáció</option></select></label>
      </div>
      <p className="scanner-count">{visibleRows.length} / {rows.length} token</p>
      {visibleRows.length === 0 ? <EmptyState message={rows.length ? 'Nincs a szűrőknek megfelelő token.' : 'Az API nem adott vissza tokent.'} /> : (
        <DataTable wide headers={['Token', 'Ár · 24h', 'Likviditás · MC', '24h forgalom', 'Kockázat', 'Jelzés', 'Döntés', '']}>
          {visibleRows.map((row: any) => {
            const change = numberValue(row.priceChange24h);
            return <tr key={row.id} className="clickable-row" onClick={() => router.push(`/tokens/${row.address}`)}>
              <td><Link className="table-link token-name token-label" href={`/tokens/${row.address}`} title={row.address} onClick={(event) => event.stopPropagation()}><TokenAvatar address={row.address} symbol={row.symbol} size={26} /><strong>{row.symbol}</strong><small>{row.name ?? 'Token'} · {row.address ? `${row.address.slice(0, 4)}…${row.address.slice(-4)}` : '—'}</small></Link></td>
              <td title={qualityLabel(row.dataQuality)}><Stacked top={formatPrice(numberValue(row.priceUsd))} bottom={row.priceChange24h == null ? 'N/A' : <span className={change >= 0 ? 'positive-value' : 'negative-value'}>{change > 0 ? '+' : ''}{fmt(change)}% {change >= 0 ? '↑' : '↓'}</span>} /></td>
              <td><Stacked top={row.liquidityUsd == null ? 'N/A' : `$${fmt(numberValue(row.liquidityUsd), 0)}`} bottom={row.marketCap == null ? null : `MC $${fmt(numberValue(row.marketCap), 0)}`} /></td>
              <td>{row.volume24h == null ? 'N/A' : `$${fmt(numberValue(row.volume24h), 0)}`}</td>
              <td>
                {row.riskScore != null
                  ? <Stacked top={<Status tone={riskTone(row.riskClassification)}>{label(row.riskClassification)}</Status>} bottom={`${fmt(numberValue(row.riskScore), 0)}/100`} />
                  : <span className="annotation" title={row.riskStatus === 'FAILED' ? 'Az elemzés sikertelen' : 'Az elemzés még nem futott le'}>{row.riskStatus === 'FAILED' ? 'Elemzés sikertelen' : 'Elemzés…'}</span>}
              </td>
              <td>
                {row.signalScore != null
                  ? <Stacked top={<Status tone={directionTone(row.signalDirection)}>{row.signalDirection ? label(row.signalDirection) : 'Jelzés'}</Status>} bottom={`${fmt(numberValue(row.signalScore), 0)}/100 · ${String(row.signalStrategyName ?? 'Stratégia').replace('Strategy', '')}`} />
                  : <span className="annotation">{row.signalStatus === 'FAILED' ? 'Elemzés sikertelen' : row.signalStatus === 'NO_ACTIVE_STRATEGY' ? 'Nincs aktív stratégia' : 'Elemzés…'}</span>}
                {row.ai ? <div className="ai-badge-line"><Status tone={aiDecisionTone(row.ai.decision)}>AI: {AI_DECISION_LABELS[row.ai.decision] ?? row.ai.decision}{row.ai.confidence != null ? ` ${Math.round(row.ai.confidence)}` : ''}</Status></div> : null}
              </td>
              <td>{row.skipped
                ? <span title={`Ok: ${describeReasons(String(row.skipped.reason ?? '').split(', ').filter(Boolean))}`}><Stacked top={<Status tone="neutral">Kihagyva</Status>} bottom={`${new Date(row.skipped.until).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}-ig`} /></span>
                : <Status tone={riskTone(row.decision)}>{label(row.decision, 'Elemzés...')}</Status>}</td>
              <td>{row.riskHardBlocked || row.dataQuality === 'INVALID' || row.dataQuality === 'STALE' || numberValue(row.priceUsd) <= 0 ? <span className="annotation">Nem vásárolható</span> : <button type="button" className="text-button" onClick={(event) => { event.stopPropagation(); setSelectedToken(row); setBuyMessage(''); }} disabled={row.decision !== 'WATCH' && row.decision !== 'APPROVED_REDUCED_SIZE' && row.decision !== 'APPROVED'}>Paper vétel</button>}</td>
            </tr>;
          })}
        </DataTable>
      )}
    </Panel>
    {selectedToken && <div className="modal-backdrop" role="presentation"><section className="confirm-modal manual-buy-modal" role="dialog" aria-modal="true" aria-labelledby="manual-buy-title">
      <p className="eyebrow">Paper kereskedés</p>
      <h2 id="manual-buy-title">Paper vétel</h2>
      <div className="manual-buy-summary"><strong className="token-label"><TokenAvatar address={selectedToken.address} symbol={selectedToken.symbol} size={28} />{selectedToken.symbol}</strong><span>Aktuális ár: {formatPrice(numberValue(selectedToken.priceUsd))}</span><span>Kockázat: {fmt(numberValue(selectedToken.riskScore), 0)} / 100 · {label(selectedToken.riskClassification)}</span><span>Jelzés: {selectedToken.signalScore == null ? 'N/A' : `${fmt(numberValue(selectedToken.signalScore), 0)} / 100`}</span><span>Likviditás: {fmt(numberValue(selectedToken.liquidityUsd))}</span><span>24 órás forgalom: {fmt(numberValue(selectedToken.volume24h))}</span></div>
      {(selectedToken.riskClassification === 'HIGH' || selectedToken.riskClassification === 'VERY_HIGH') && <p className="risk-policy-warning">Ez a token magas kockázatú. A rendszer automatikusan még nem hagyta jóvá a belépést. A manuális Paper vétellel szimulált pozíciót nyitsz.</p>}
      <label>Pozícióméret<select value={amountType} onChange={(event) => setAmountType(event.target.value as typeof amountType)}><option value="USDC">USDC összeg</option><option value="EQUITY_PERCENT">Számla százaléka</option></select><input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <p className="annotation">A szerver újraellenőrzi az árat, likviditást, hard blockokat és minden pozíciólimitet.</p>
      {buyMessage && <p className={`wallet-message ${buyTone}`} role={buyTone === 'error' ? 'alert' : 'status'}>{buyMessage}</p>}
      <div className="modal-actions"><button type="button" className="control-button" onClick={() => setSelectedToken(null)} disabled={buying}>Mégse</button><button type="button" className="primary-button" onClick={() => void manualBuy()} disabled={buying || Number(amount) <= 0}>{buying ? 'Feldolgozás…' : 'Paper vétel megerősítése'}</button></div>
    </section></div>}
  </>;
}
