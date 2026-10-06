'use client';

import { useState } from 'react';

import { apiRequest, Panel, Status, useApi } from './components';

type SafetyCheck = { name: string; passed: boolean; reason: string };
type LiveSafetyReport = {
  status: 'LIVE READY' | 'LIVE BLOCKED';
  canEnable: boolean;
  canRequestEnable: boolean;
  liveEnabled: boolean;
  canManageLive: boolean;
  emergencyStop: boolean;
  checks: SafetyCheck[];
  blockingReasons: string[];
};

export function LiveSafetyControls({ onChange }: { onChange?: () => void }) {
  const { data, error, loading, refresh } = useApi<{ data: LiveSafetyReport }>('/api/safety/live');
  const [confirming, setConfirming] = useState(false);
  const [clearingEmergency, setClearingEmergency] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [clearAcknowledged, setClearAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const report = data?.data;

  const enableLive = async () => {
    try {
      setBusy(true);
      setActionError('');
      await apiRequest('/api/safety/live/enable', { method: 'POST', body: JSON.stringify({ confirmLiveTrading: true }) });
      setConfirming(false);
      setAcknowledged(false);
      refresh();
      onChange?.();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : 'Unable to enable LIVE trading');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const disableLive = async () => {
    try {
      setBusy(true);
      setActionError('');
      await apiRequest('/api/safety/live/disable', { method: 'POST', body: '{}' });
      refresh();
      onChange?.();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : 'Unable to disable LIVE trading');
    } finally {
      setBusy(false);
    }
  };

  const clearEmergencyStop = async () => {
    try {
      setBusy(true);
      setActionError('');
      await apiRequest('/api/safety/emergency-stop/clear', {
        method: 'POST',
        body: JSON.stringify({ confirmEmergencyStopClear: true }),
      });
      setClearingEmergency(false);
      setClearAcknowledged(false);
      refresh();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : 'Unable to clear emergency stop');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="LIVE biztonsági kapu" className="live-safety-panel">
        {loading && <p className="annotation">LIVE előfeltételek ellenőrzése…</p>}
        {error && <div className="state-panel error-state">LIVE blokkolva: {error}</div>}
        {report && <>
          <div className="live-gate-summary">
            <Status tone={report.canEnable ? 'positive' : 'danger'}>{report.canEnable ? 'LIVE ENGEDÉLYEZHETŐ' : 'LIVE BLOKKOLVA'}</Status>
            <span className="live-gate-count"><strong>{report.checks.filter((check) => check.passed).length}</strong> / {report.checks.length} biztonsági feltétel teljesül</span>
            <span className="annotation" style={{ margin: 0 }}>LIVE kereskedés: {report.liveEnabled ? 'engedélyezve' : 'kikapcsolva'} · a Paper kereskedést ez nem érinti.</span>
            {report.emergencyStop && <Status tone="danger">VÉSZLEÁLLÍTÁS</Status>}
          </div>
          <div className="live-progress" aria-hidden="true"><span style={{ width: `${report.checks.length ? report.checks.filter((check) => check.passed).length / report.checks.length * 100 : 0}%` }} /></div>
          <details className="live-details">
            <summary>Feltételek részletesen</summary>
            <div className="live-check-list">
              {report.checks.map((check) => <div className="live-check" key={check.name}>
                <span>{check.name.replaceAll('_', ' ')}</span>
                <Status tone={check.passed ? 'positive' : 'danger'}>{check.passed ? 'Teljesül' : check.reason}</Status>
              </div>)}
            </div>
          </details>
          {actionError && <div className="state-panel error-state">{actionError}</div>}
          {report.canManageLive && <div className="live-gate-actions">
            {!report.liveEnabled
              ? <button type="button" className="emergency-button" disabled={!report.canRequestEnable || busy} onClick={() => { setAcknowledged(false); setConfirming(true); }}>LIVE áttekintése és engedélyezése</button>
              : <button type="button" className="control-button stop" disabled={busy} onClick={() => void disableLive()}>LIVE kereskedés letiltása</button>}
            {report.emergencyStop && <button type="button" className="control-button stop" disabled={busy} onClick={() => { setClearAcknowledged(false); setClearingEmergency(true); }}>Vészleállítás feloldásának áttekintése</button>}
          </div>}
        </>}
      </Panel>
      {confirming && <div className="modal-backdrop">
        <section className="confirm-modal live-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="live-confirm-title">
          <p className="eyebrow">Végső megerősítés</p>
          <h2 id="live-confirm-title">Engedélyezed a LIVE kereskedést?</h2>
          <p>A LIVE kereskedés valódi tranzakciókat indíthat és pénzvesztéssel járhat. A szerver minden biztonsági feltételt újraellenőriz.</p>
          <label className="toggle-row live-acknowledgement">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            Megértem, hogy ez valódi pénzes kereskedést engedélyez.
          </label>
          <div className="modal-actions">
            <button type="button" className="control-button" disabled={busy} onClick={() => setConfirming(false)}>Mégse</button>
            <button type="button" className="emergency-button" disabled={!acknowledged || busy} onClick={() => void enableLive()}>{busy ? 'Ellenőrzés…' : 'LIVE kereskedés engedélyezése'}</button>
          </div>
        </section>
      </div>}
      {clearingEmergency && <div className="modal-backdrop">
        <section className="confirm-modal live-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="emergency-clear-title">
          <p className="eyebrow">Adminisztrátori megerősítés</p>
          <h2 id="emergency-clear-title">Feloldod a vészleállítást?</h2>
          <p>A feloldás nem engedélyezi a LIVE kereskedést. Minden LIVE biztonsági feltételnek teljesülnie kell, majd külön végső megerősítés szükséges.</p>
          <label className="toggle-row live-acknowledgement">
            <input type="checkbox" checked={clearAcknowledged} onChange={(event) => setClearAcknowledged(event.target.checked)} />
            Áttekintettem az incidenst, és engedélyezem a leállítás feloldását.
          </label>
          <div className="modal-actions">
            <button type="button" className="control-button" disabled={busy} onClick={() => setClearingEmergency(false)}>Mégse</button>
            <button type="button" className="emergency-button" disabled={!clearAcknowledged || busy} onClick={() => void clearEmergencyStop()}>{busy ? 'Feloldás…' : 'Vészleállítás feloldása'}</button>
          </div>
        </section>
      </div>}
    </>
  );
}
