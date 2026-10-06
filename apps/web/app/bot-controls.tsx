'use client';

import { useState } from 'react';

import { apiRequest, ErrorState, LoadingState, useApi } from './components';
import { type BotStatus, useBotStatus } from './hooks/useBotStatus';

const statusTone: Record<BotStatus, string> = { RUNNING: 'positive', PAUSED: 'warning', STOPPED: 'neutral', EMERGENCY_STOP: 'danger' };

export function BotStatusBadge({ status }: { status?: BotStatus | null }) {
  const resolved = status ?? 'STOPPED';
  const names: Record<BotStatus, string> = { RUNNING: 'Fut', PAUSED: 'Szüneteltetve', STOPPED: 'Leállítva', EMERGENCY_STOP: 'Vészleállítás' };
  return <span className={`bot-status-badge ${statusTone[resolved]}`}><span className="status-dot" />{names[resolved]}</span>;
}

export function BotMasterControls() {
  const { botState, error, isLoading, command } = useBotStatus();
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [message, setMessage] = useState('');

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const runCommand = async (action: 'start' | 'pause' | 'stop') => {
    setBusy(true); setMessage('');
    try { await command(action); setMessage('A parancs elküldve.'); } catch (commandError) { setMessage(commandError instanceof Error ? commandError.message : 'A parancs sikertelen'); } finally { setBusy(false); }
  };
  const emergency = async () => {
    setBusy(true); setMessage('');
    try { await command('emergency-stop'); setMessage('A vészleállítás aktiválva.'); setModalOpen(false); } catch (commandError) { setMessage(commandError instanceof Error ? commandError.message : 'A vészleállítás sikertelen'); } finally { setBusy(false); }
  };

  return <div className="bot-controls">
    <div className="bot-control-heading"><div><span className="eyebrow">Botvezérlés</span><h2>Fő vezérlők</h2></div><BotStatusBadge status={botState?.status} /></div>
    <div className="bot-control-actions"><button type="button" className="control-button start" disabled={busy} onClick={() => runCommand('start')}>Indítás</button><button type="button" className="control-button pause" disabled={busy} onClick={() => runCommand('pause')}>Szüneteltetés</button><button type="button" className="control-button stop" disabled={busy} onClick={() => runCommand('stop')}>Leállítás</button><button type="button" className="emergency-button" disabled={busy} onClick={() => setModalOpen(true)}>VÉSZLEÁLLÍTÁS</button></div>
    {message && <p className="control-feedback">{message}</p>}
    {modalOpen && <div className="modal-backdrop" role="presentation"><div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="emergency-title"><p className="eyebrow">Visszafordíthatatlan vezérlés</p><h2 id="emergency-title">Biztosan aktiválod a vészleállítást?</h2><p>Ez azonnal leállítja az új belépéseket és törli a függő ajánlatokat. A meglévő pozíciók védelmét továbbra is a Worker kezeli.</p><div className="modal-actions"><button type="button" className="text-button" onClick={() => setModalOpen(false)} disabled={busy}>Mégse</button><button type="button" className="emergency-button" onClick={emergency} disabled={busy}>{busy ? 'Aktiválás...' : 'Vészleállítás megerősítése'}</button></div></div></div>}
  </div>;
}

type StrategySettings = Record<string, { isEnabled: boolean; params: Record<string, number> }>;

const strategyDescriptions: Record<string, string> = {
  Momentum: 'Rövid távú lendület, gyorsuló volumen és vételi nyomás.',
  Breakout: 'Konszolidációból, ellenállás felett, volumennel megerősített kitörés.',
  Pullback: 'Erős impulzus utáni visszahúzódás támaszon, megújuló vételi nyomással.',
};

/** Per-account strategy switches: exactly the StrategyConfig rows the worker's strategy runner reads. */
export function StrategyControlCards() {
  const { data, error, loading, refresh } = useApi<{ data: StrategySettings }>('/api/settings/strategies');
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} />;
  const strategies = data?.data ?? {};
  const toggle = async (name: string, enabled: boolean) => {
    setPending(name); setToast('');
    try {
      await apiRequest(`/api/settings/strategies/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ isEnabled: enabled }) });
      setToast(`${name} ${enabled ? 'bekapcsolva' : 'kikapcsolva'}.`);
      refresh();
    } catch (toggleError) {
      setToast(toggleError instanceof Error ? toggleError.message : 'A stratégia módosítása sikertelen');
    } finally {
      setPending(null);
    }
  };
  return <div className="strategy-control-grid">{Object.entries(strategies).map(([name, strategy]) => <div className="strategy-control-card" key={name}><div><h3>{name}</h3><p>{strategy.isEnabled ? 'Aktív – a worker ezzel a stratégiával generál jelzéseket.' : 'Kikapcsolva.'} {strategyDescriptions[name] ?? ''}</p></div><label className="toggle-label"><input type="checkbox" checked={strategy.isEnabled} disabled={pending === name} onChange={(event) => toggle(name, event.target.checked)} /><span className="toggle-track" /><span className="sr-only">{name} kapcsoló</span></label></div>)}{toast && <div className="toast" role="status">{toast}</div>}</div>;
}
