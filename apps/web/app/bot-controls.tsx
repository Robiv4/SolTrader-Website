'use client';

import { useState } from 'react';

import { ErrorState, LoadingState } from './components';
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
