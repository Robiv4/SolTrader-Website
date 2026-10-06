'use client';

import { KeyRound, LogOut, Shield, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { UserAvatar } from '../avatars';
import { apiRequest, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Panel, Stacked, Status, useApi } from '../components';

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: 'ADMIN' | 'USER';
  createdAt: string;
  avatarVersion: number | null;
  isSelf: boolean;
  isBootstrapAdmin: boolean;
  openPositions: number;
  trades: number;
  equity: number | null;
  bot: { status: string; tradingMode: string } | null;
  activeSessions: number;
  lastLoginAt: string | null;
}

type Dialog =
  | { kind: 'password'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser }
  | { kind: 'role'; user: AdminUser; role: 'ADMIN' | 'USER' }
  | { kind: 'sessions'; user: AdminUser }
  | null;

const dateText = (value: string | null) => (value ? new Date(value).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const usd = (value: number | null) => (value == null ? '—' : `${value.toLocaleString('hu-HU', { maximumFractionDigits: 2 })} USDC`);

/** Administrator user management: create accounts (USER / ADMIN), grant / revoke admin, reset password, sign out, delete. */
export default function UsersPage() {
  const { data: me } = useApi<{ data: { role: string } }>('/api/auth/me');
  const isAdmin = me?.data?.role === 'ADMIN';
  if (me && !isAdmin) {
    return <div className="page-stack">
      <PageHeader eyebrow="Fiók" title="Felhasználók" />
      <ErrorState message="Ehhez az oldalhoz admin jogosultság kell." />
    </div>;
  }
  return isAdmin ? <UsersAdmin /> : <LoadingState />;
}

function UsersAdmin() {
  const { data, error, loading, refresh } = useApi<{ data: { currentUserId: string; admins: number; users: AdminUser[] } }>('/api/admin/users');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<{ tone: 'positive' | 'negative'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      setNotice({ tone: 'positive', text: success });
      setDialog(null);
      refresh();
    } catch (caught) {
      setNotice({ tone: 'negative', text: caught instanceof Error ? caught.message : 'A művelet nem sikerült' });
    } finally {
      setBusy(false);
    }
  };

  const users = data?.data.users ?? [];
  const admins = data?.data.admins ?? 0;
  return <div className="page-stack">
    <PageHeader eyebrow="Fiók · Admin" title="Felhasználók" subtitle="Fiókok létrehozása, admin jog adása / elvétele, jelszócsere, kijelentkeztetés és törlés." />
    {notice ? <div className={notice.tone === 'positive' ? 'state-panel' : 'settings-warning'} role="status">{notice.text}</div> : null}
    <CreateUserPanel busy={busy} onCreate={(payload) => run(() => apiRequest('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }), `Fiók létrehozva: ${payload.email}`)} />
    <Panel title="Fiókok" description={`${users.length} fiók · ${admins} admin. A saját fiókodat, az utolsó admint és a szerver-konfigurációs admint (ADMIN_EMAIL) nem lehet törölni vagy lefokozni.`}>
      {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} /> : !users.length ? <EmptyState message="Nincs fiók." /> : <DataTable wide headers={['Felhasználó', 'Szerep', 'Bot', 'Paper egyenleg', 'Pozíciók / trade-ek', 'Utolsó belépés', 'Létrehozva', 'Műveletek']}>
        {users.map((user) => {
          const lastAdmin = user.role === 'ADMIN' && admins <= 1;
          const protectedAdmin = user.isSelf || user.isBootstrapAdmin || lastAdmin;
          const why = user.isSelf ? 'Saját fiók' : user.isBootstrapAdmin ? 'Szerver-konfigurációs admin (ADMIN_EMAIL)' : lastAdmin ? 'Utolsó admin' : '';
          return <tr key={user.id}>
            <td><span className="token-label"><UserAvatar userId={user.id} version={user.avatarVersion} name={user.name} email={user.email} size={32} /><Stacked top={<strong>{user.name || user.email}{user.isSelf ? ' (te)' : ''}</strong>} bottom={user.name ? user.email : null} /></span></td>
            <td><Status tone={user.role === 'ADMIN' ? 'warning' : 'neutral'}>{user.role === 'ADMIN' ? 'ADMIN' : 'FELHASZNÁLÓ'}</Status>{user.isBootstrapAdmin ? <small className="sample-note"> · rendszer</small> : null}</td>
            <td>{user.bot ? <Stacked top={user.bot.status} bottom={user.bot.tradingMode} /> : '—'}</td>
            <td>{usd(user.equity)}</td>
            <td>{user.openPositions} nyitott / {user.trades}</td>
            <td><Stacked top={dateText(user.lastLoginAt)} bottom={`${user.activeSessions} aktív munkamenet`} /></td>
            <td>{dateText(user.createdAt)}</td>
            <td>
              <div className="modal-actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
                {user.role === 'USER'
                  ? <button type="button" className="secondary-button small" disabled={busy} onClick={() => setDialog({ kind: 'role', user, role: 'ADMIN' })}><Shield size={14} aria-hidden="true" /> Admin jog</button>
                  : <button type="button" className="secondary-button small" disabled={busy || protectedAdmin} title={why} onClick={() => setDialog({ kind: 'role', user, role: 'USER' })}><ShieldOff size={14} aria-hidden="true" /> Admin jog elvétele</button>}
                <button type="button" className="secondary-button small" disabled={busy} onClick={() => setDialog({ kind: 'password', user })}><KeyRound size={14} aria-hidden="true" /> Jelszó</button>
                <button type="button" className="secondary-button small" disabled={busy || user.activeSessions === 0} onClick={() => setDialog({ kind: 'sessions', user })}><LogOut size={14} aria-hidden="true" /> Kijelentkeztetés</button>
                <button type="button" className="danger-button small" disabled={busy || user.isSelf || user.isBootstrapAdmin || lastAdmin} title={why} onClick={() => setDialog({ kind: 'delete', user })}><Trash2 size={14} aria-hidden="true" /> Törlés</button>
              </div>
            </td>
          </tr>;
        })}
      </DataTable>}
    </Panel>
    {dialog?.kind === 'role' ? <ConfirmDialog busy={busy} title={dialog.role === 'ADMIN' ? 'Admin jog adása' : 'Admin jog elvétele'}
      text={dialog.role === 'ADMIN' ? `${dialog.user.email} admin lesz: kezelheti a felhasználókat, a botot és a biztonsági beállításokat.` : `${dialog.user.email} visszakerül sima felhasználónak. Azonnal érvényes.`}
      confirmLabel={dialog.role === 'ADMIN' ? 'Admin jog adása' : 'Admin jog elvétele'} onCancel={() => setDialog(null)}
      onConfirm={() => run(() => apiRequest(`/api/admin/users/${dialog.user.id}`, { method: 'PATCH', body: JSON.stringify({ role: dialog.role }) }), dialog.role === 'ADMIN' ? `${dialog.user.email} mostantól admin.` : `${dialog.user.email} admin joga elvéve.`)} /> : null}
    {dialog?.kind === 'sessions' ? <ConfirmDialog busy={busy} title="Kijelentkeztetés minden eszközről" text={`${dialog.user.email} összes aktív munkamenete megszűnik${dialog.user.isSelf ? ' (a jelenlegi munkameneted kivételével)' : ''}.`}
      confirmLabel="Kijelentkeztetés" onCancel={() => setDialog(null)}
      onConfirm={() => run(() => apiRequest(`/api/admin/users/${dialog.user.id}/sessions/revoke`, { method: 'POST', body: '{}' }), 'Munkamenetek lezárva.')} /> : null}
    {dialog?.kind === 'password' ? <PasswordDialog user={dialog.user} busy={busy} onCancel={() => setDialog(null)}
      onSubmit={(password) => run(() => apiRequest(`/api/admin/users/${dialog.user.id}/password`, { method: 'POST', body: JSON.stringify({ password }) }), `Új jelszó beállítva: ${dialog.user.email} (a többi munkamenete lezárva).`)} /> : null}
    {dialog?.kind === 'delete' ? <DeleteDialog user={dialog.user} busy={busy} onCancel={() => setDialog(null)}
      onSubmit={(confirmEmail) => run(() => apiRequest(`/api/admin/users/${dialog.user.id}`, { method: 'DELETE', body: JSON.stringify({ confirmEmail }) }), `Fiók törölve: ${dialog.user.email}`)} /> : null}
  </div>;
}

function CreateUserPanel({ busy, onCreate }: { busy: boolean; onCreate: (payload: { email: string; name: string; password: string; role: 'USER' | 'ADMIN' }) => Promise<void> }) {
  const [form, setForm] = useState({ email: '', name: '', password: '', passwordAgain: '', role: 'USER' as 'USER' | 'ADMIN' });
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.password.length < 10) return setLocalError('A jelszó legalább 10 karakter legyen.');
    if (form.password !== form.passwordAgain) return setLocalError('A két jelszó nem egyezik.');
    setLocalError(null);
    await onCreate({ email: form.email.trim(), name: form.name.trim(), password: form.password, role: form.role });
    setForm({ email: '', name: '', password: '', passwordAgain: '', role: 'USER' });
  };
  return <Panel title="Új fiók létrehozása" description="A paper számla és az alapbeállítások az első belépéskor jönnek létre. Admin fiók is létrehozható.">
    <form onSubmit={(event) => void submit(event)}>
      <div className="sgrid">
        <label className="sfield"><span className="sfield-label">E-mail</span><input type="email" required autoComplete="off" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="sfield"><span className="sfield-label">Név (opcionális)</span><input type="text" maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="sfield"><span className="sfield-label">Jelszó</span><input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><span className="sfield-help">Legalább 10 karakter.</span></label>
        <label className="sfield"><span className="sfield-label">Jelszó újra</span><input type="password" required minLength={10} autoComplete="new-password" value={form.passwordAgain} onChange={(event) => setForm({ ...form, passwordAgain: event.target.value })} /></label>
        <label className="sfield"><span className="sfield-label">Szerep</span>
          <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as 'USER' | 'ADMIN' })}>
            <option value="USER">Felhasználó</option>
            <option value="ADMIN">Admin</option>
          </select>
          <span className="sfield-help">{form.role === 'ADMIN' ? 'Az admin kezelheti a felhasználókat, a botot és a biztonsági beállításokat.' : 'Saját paper kereskedés és beállítások.'}</span>
        </label>
      </div>
      {localError ? <p className="settings-warning">{localError}</p> : null}
      <div className="modal-actions"><button type="submit" className="primary-button" disabled={busy}><UserPlus size={16} aria-hidden="true" /> {busy ? 'Mentés…' : 'Fiók létrehozása'}</button></div>
    </form>
  </Panel>;
}

function ConfirmDialog({ title, text, confirmLabel, busy, onCancel, onConfirm }: { title: string; text: string; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation"><div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title">
    <h2 id="user-dialog-title">{title}</h2><p>{text}</p>
    <div className="modal-actions"><button type="button" className="text-button" onClick={onCancel} disabled={busy}>Mégse</button><button type="button" className="primary-button" onClick={onConfirm} disabled={busy}>{busy ? 'Folyamatban…' : confirmLabel}</button></div>
  </div></div>;
}

function PasswordDialog({ user, busy, onCancel, onSubmit }: { user: AdminUser; busy: boolean; onCancel: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const valid = password.length >= 10 && password === again;
  return <div className="modal-backdrop" role="presentation"><div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title">
    <h2 id="password-dialog-title">Új jelszó</h2><p>{user.email} új jelszava. A fiók többi munkamenete megszűnik.</p>
    <label className="sfield"><span className="sfield-label">Új jelszó</span><input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <label className="sfield"><span className="sfield-label">Új jelszó újra</span><input type="password" autoComplete="new-password" minLength={10} value={again} onChange={(event) => setAgain(event.target.value)} /><span className="sfield-help">{password && password.length < 10 ? 'Legalább 10 karakter.' : again && again !== password ? 'A két jelszó nem egyezik.' : ' '}</span></label>
    <div className="modal-actions"><button type="button" className="text-button" onClick={onCancel} disabled={busy}>Mégse</button><button type="button" className="primary-button" disabled={busy || !valid} onClick={() => onSubmit(password)}>{busy ? 'Mentés…' : 'Jelszó beállítása'}</button></div>
  </div></div>;
}

function DeleteDialog({ user, busy, onCancel, onSubmit }: { user: AdminUser; busy: boolean; onCancel: () => void; onSubmit: (confirmEmail: string) => void }) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();
  return <div className="modal-backdrop" role="presentation"><div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
    <p className="eyebrow">Visszafordíthatatlan</p>
    <h2 id="delete-dialog-title">Fiók végleges törlése</h2>
    <p>{user.email} fiókja és minden saját adata törlődik: {user.openPositions} nyitott pozíció, {user.trades} trade, paper számla, beállítások, jelzések. Az audit napló bejegyzései megmaradnak, a fióktól leválasztva.</p>
    <label className="sfield"><span className="sfield-label">Megerősítéshez írd be az e-mail címet</span><input type="text" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={user.email} /></label>
    <div className="modal-actions"><button type="button" className="text-button" onClick={onCancel} disabled={busy}>Mégse</button><button type="button" className="danger-button" disabled={busy || !matches} onClick={() => onSubmit(typed.trim())}>{busy ? 'Törlés…' : 'Végleges törlés'}</button></div>
  </div></div>;
}
