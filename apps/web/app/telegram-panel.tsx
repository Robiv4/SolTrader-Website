'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest, Panel, Status } from './components';

type TelegramState = { botConfigured: boolean; botRunning: boolean; botUsername: string | null; linked: boolean; enabled: boolean; chatIdHint: string | null };

/** Links the user's Telegram account to the bot; SEMI_AUTO approval requests are then delivered there. */
export function TelegramPanel({ tradingMode }: { tradingMode?: string }) {
  const [state, setState] = useState<TelegramState | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'neutral' | 'success' | 'error' } | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(undefined);

  const load = useCallback(async () => {
    const response = await apiRequest<{ data: TelegramState }>('/api/settings/telegram');
    setState(response.data);
    return response.data;
  }, []);

  useEffect(() => {
    void load().catch((error: Error) => setMessage({ text: error.message, tone: 'error' }));
    return () => { if (pollTimer.current) globalThis.clearInterval(pollTimer.current); };
  }, [load]);

  const link = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiRequest<{ data: { url: string; expiresAt: string } }>('/api/settings/telegram/link', { method: 'POST', body: '{}' });
      setLinkUrl(response.data.url);
      globalThis.open(response.data.url, '_blank', 'noopener');
      setMessage({ text: 'Megnyílt a Telegram. Nyomd meg a „Start” gombot a botnál – a csatolás automatikusan megtörténik.', tone: 'neutral' });
      if (pollTimer.current) globalThis.clearInterval(pollTimer.current);
      const deadline = Date.now() + 10 * 60_000;
      pollTimer.current = globalThis.setInterval(() => {
        void load().then((next) => {
          if (next.linked) {
            globalThis.clearInterval(pollTimer.current);
            setLinkUrl(null);
            setMessage({ text: 'Telegram-fiók csatolva. A bot üzenetet küldött neked.', tone: 'success' });
          } else if (Date.now() > deadline) {
            globalThis.clearInterval(pollTimer.current);
            setMessage({ text: 'A csatolási link lejárt. Próbáld újra.', tone: 'error' });
          }
        }).catch(() => undefined);
      }, 3000);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'A csatolás nem indítható', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const run = async (path: string, success: string, body: unknown = {}) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest(path, { method: path.includes('notifications') ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setMessage({ text: success, tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'A művelet sikertelen', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return <Panel title="Telegram">
    {message && <p className={`wallet-message ${message.tone}`} role="status">{message.text}</p>}
    {!state ? <p className="annotation">Betöltés…</p>
      : !state.botConfigured ? <div className="telegram-setup">
        <p><strong>A Telegram bot még nincs beállítva.</strong> Egyszer kell elvégezni:</p>
        <ol>
          <li>Telegramon nyisd meg a <code>@BotFather</code>-t, küldd el: <code>/newbot</code>, és adj nevet a botnak.</li>
          <li>A kapott tokent írd be a projekt <code>.env</code> fájljába: <code>TELEGRAM_BOT_TOKEN=…</code></li>
          <li>Indítsd újra az API-t, majd itt kattints a „Telegram csatolása” gombra.</li>
        </ol>
      </div>
        : !state.botRunning ? <p className="wallet-message error">A Telegram bot token be van állítva, de a bot nem indult el. Ellenőrizd a tokent és az API naplóját.</p>
          : <>
            <div className="wallet-item">
              <div>
                <strong>Bot: @{state.botUsername}</strong>
                <small>{state.linked ? `Csatolt chat: ${state.chatIdHint}` : 'Nincs csatolt Telegram-fiók'}</small>
              </div>
              <Status tone={state.enabled ? 'positive' : state.linked ? 'warning' : 'neutral'}>{state.enabled ? 'AKTÍV' : state.linked ? 'KIKAPCSOLVA' : 'NINCS CSATOLVA'}</Status>
            </div>
            <div className="header-actions" style={{ marginTop: 14 }}>
              {!state.linked && <button type="button" className="primary-button" disabled={busy} onClick={() => void link()}>Telegram csatolása</button>}
              {state.linked && <button type="button" className="secondary-button" disabled={busy} onClick={() => void run('/api/settings/notifications', state.enabled ? 'Telegram értesítések kikapcsolva.' : 'Telegram értesítések bekapcsolva.', { telegramEnabled: !state.enabled })}>{state.enabled ? 'Értesítések kikapcsolása' : 'Értesítések bekapcsolása'}</button>}
              {state.linked && <button type="button" className="secondary-button" disabled={busy || !state.enabled} onClick={() => void run('/api/settings/telegram/test', 'Tesztüzenet elküldve.')}>Tesztüzenet</button>}
              {state.linked && <button type="button" className="danger-button" disabled={busy} onClick={() => void run('/api/settings/telegram/unlink', 'Telegram-fiók leválasztva.')}>Leválasztás</button>}
            </div>
            {linkUrl && <p className="annotation">Ha nem nyílt meg: <a className="table-link" href={linkUrl} target="_blank" rel="noreferrer">csatolási link megnyitása</a> (10 percig érvényes).</p>}
            <p className="annotation">SEMI_AUTO módban minden vételi javaslat ide érkezik „Elfogadom / Elutasítom” gombokkal; az elfogadott vétel azonnal végrehajtódik a paper számlán.{tradingMode !== 'SEMI_AUTO' ? ' A fiókod most nem SEMI_AUTO módban van – a Kereskedés panelen állíthatod át.' : ''}</p>
          </>}
  </Panel>;
}
