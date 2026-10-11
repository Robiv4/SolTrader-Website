'use client';

import { Activity, BarChart3, BrainCircuit, Rocket, ChevronRight, LayoutDashboard, List, Menu, Settings2, ShieldCheck, Users, Wallet, X, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Children, cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { hu, translateText } from './locales/hu';
import { ProfileMenu, ThemeToggle } from './topbar';

const navGroups: Array<{ label: string; items: Array<{ href: string; label: string; icon: LucideIcon; adminOnly?: boolean }> }> = [
  { label: hu.nav.overview, items: [{ href: 'dashboard', label: hu.nav.dashboard, icon: LayoutDashboard }, { href: 'positions', label: hu.nav.positions, icon: List }, { href: 'trades', label: hu.nav.trades, icon: Activity }] },
  { label: hu.nav.markets, items: [{ href: 'new-launch', label: hu.nav.newLaunch, icon: Rocket }, { href: 'signals', label: hu.nav.signals, icon: Activity }] },
  { label: hu.nav.insights, items: [{ href: 'analytics', label: hu.nav.analytics, icon: BarChart3 }, { href: 'machine-learning', label: 'Machine Learning', icon: BrainCircuit }] },
  { label: hu.nav.account, items: [{ href: 'wallet', label: hu.nav.wallet, icon: Wallet }, { href: 'settings', label: hu.nav.settings, icon: Settings2 }, { href: 'users', label: 'Felhasználók', icon: Users, adminOnly: true }] },
  { label: hu.nav.system, items: [{ href: 'system', label: hu.nav.health, icon: ShieldCheck }, { href: 'logs', label: hu.nav.logs, icon: Activity }] },
];

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** E-mail code request for a sensitive action (HTTP 428 VERIFICATION_REQUIRED from the API). */
export interface StepUpChallenge { challengeId: string; emailHint: string; expiresAt: string; actionLabel?: string; error?: string }
type StepUpHandler = (challenge: StepUpChallenge) => Promise<string | null>;
let stepUpHandler: StepUpHandler | null = null;

/** The app shell registers the code dialog; apiRequest uses it for every sensitive action. */
export function registerStepUpHandler(handler: StepUpHandler) {
  stepUpHandler = handler;
  return () => {
    if (stepUpHandler === handler) stepUpHandler = null;
  };
}

export async function apiRequest<T>(path: string, init?: globalThis.RequestInit): Promise<T> {
  const send = (body?: globalThis.BodyInit | null) => globalThis.fetch(`${apiBase}${path}`, { ...init, ...(body !== undefined ? { body } : {}), credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  let response = await send();
  if (response.status === 429) {
    // A 429 means the request was not processed, so one delayed retry is safe for reads and actions alike.
    const retryAfter = Number(response.headers.get('retry-after') ?? response.headers.get('ratelimit-reset'));
    const waitMs = Math.min(Math.max(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000, 1000), 8000);
    await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs));
    response = await send();
  }
  const body = await response.json().catch(() => null);
  if (response.status === 428 && body?.code === 'VERIFICATION_REQUIRED' && stepUpHandler) return confirmWithCode<T>(body.data as StepUpChallenge, init, send);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

/** Asks for the e-mailed code and repeats the same request with it (a wrong code can be retried while attempts remain). */
async function confirmWithCode<T>(challenge: StepUpChallenge, init: globalThis.RequestInit | undefined, send: (body?: globalThis.BodyInit | null) => Promise<globalThis.Response>): Promise<T> {
  let error: string | undefined;
  const original = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = await stepUpHandler?.({ ...challenge, error });
    if (!code) throw new Error('A megerősítés megszakítva – a művelet nem történt meg.');
    const response = await send(JSON.stringify({ ...original, verification: { challengeId: challenge.challengeId, code } }));
    const body = await response.json().catch(() => null);
    if (response.ok) return body as T;
    if (response.status === 400 && body?.code === 'VERIFICATION_FAILED' && body?.data?.retryable) {
      error = `${body.error} Még ${body.data.attemptsLeft} próbálkozás.`;
      continue;
    }
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  throw new Error('Túl sok hibás próbálkozás.');
}

/** Modal that collects the 6-digit e-mail code for a sensitive action. */
function StepUpDialog() {
  const [pending, setPending] = useState<{ challenge: StepUpChallenge; resolve: (code: string | null) => void } | null>(null);
  const [code, setCode] = useState('');
  useEffect(() => registerStepUpHandler((challenge) => new Promise<string | null>((resolve) => {
    setCode('');
    setPending({ challenge, resolve });
  })), []);
  if (!pending) return null;
  const finish = (value: string | null) => {
    pending.resolve(value);
    setPending(null);
  };
  const valid = /^\d{6}$/.test(code);
  return <div className="modal-backdrop" role="presentation"><form className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="stepup-title" onSubmit={(event) => { event.preventDefault(); if (valid) finish(code); }}>
    <p className="eyebrow">Biztonsági megerősítés</p>
    <h2 id="stepup-title">E-mailes kód szükséges</h2>
    <p>{pending.challenge.actionLabel ? <>Művelet: <strong>{pending.challenge.actionLabel}</strong>. </> : null}Elküldtünk egy 6 jegyű kódot ide: <strong>{pending.challenge.emailHint}</strong>. A kód 10 percig érvényes.</p>
    <label className="sfield"><span className="sfield-label">Megerősítő kód</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
    {pending.challenge.error ? <p className="settings-warning" role="alert">{pending.challenge.error}</p> : null}
    <div className="modal-actions"><button type="button" className="text-button" onClick={() => finish(null)}>Mégse</button><button type="submit" className="primary-button" disabled={!valid}>Megerősítés</button></div>
  </form></div>;
}

const REFRESH_THROTTLE_MS = 3000;

export function useApi<T>(path: string) {
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; path?: string }>({ loading: true });
  useEffect(() => {
    let active = true;
    // A refresh of the same resource keeps showing the current data (no loading flash, open dialogs stay
    // mounted); only a different path starts from the loading state.
    setState((current) => (current.path === path && current.data !== undefined ? current : { loading: true, path }));
    apiRequest<T>(path).then((data) => active && setState({ data, loading: false, path })).catch((error: Error) => {
      if (active) {
        const authFailure = error.message === 'Authentication required' || error.message === 'Session expired or invalid';
        setState((current) => (!authFailure && current.path === path && current.data !== undefined
          ? { ...current, loading: false }
          : { error: error.message, loading: false, path }));
        if (authFailure) router.push('/login');
      }
    });
    return () => {
      active = false;
      if (refreshTimer.current) globalThis.clearTimeout(refreshTimer.current);
    };
  }, [path, version]);
  // Live events can arrive many times per second; refreshes are coalesced to at most one every
  // REFRESH_THROTTLE_MS, and deferred while the tab is in the background.
  const lastRefresh = useRef(0);
  const pendingWhileHidden = useRef(false);
  const refresh = useCallback(() => {
    if (typeof globalThis.document !== 'undefined' && globalThis.document.hidden) {
      pendingWhileHidden.current = true;
      return;
    }
    if (refreshTimer.current) return;
    const wait = Math.max(250, lastRefresh.current + REFRESH_THROTTLE_MS - Date.now());
    refreshTimer.current = globalThis.setTimeout(() => {
      refreshTimer.current = undefined;
      lastRefresh.current = Date.now();
      setVersion((current) => current + 1);
    }, wait);
  }, []);
  useEffect(() => {
    if (typeof globalThis.document === 'undefined') return;
    const onVisible = () => {
      if (!globalThis.document.hidden && pendingWhileHidden.current) {
        pendingWhileHidden.current = false;
        refresh();
      }
    };
    globalThis.document.addEventListener('visibilitychange', onVisible);
    return () => globalThis.document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  return { ...state, refresh };
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return <>{children}</>;
  return <AuthenticatedShell pathname={pathname}>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: settings } = useApi<{ data?: { tradingMode?: string; isPaperModeDefault?: boolean } }>('/api/settings');
  const title = navGroups.flatMap((group) => group.items).find((item) => pathname === `/${item.href}` || pathname.startsWith(`/${item.href}/`))?.label ?? 'Terminal';
  const mode = settings?.data?.tradingMode;
  const { data: me, refresh: refreshMe } = useApi<{ data: { id: string; email: string; name: string | null; role: string; avatarVersion: number | null } }>('/api/auth/me');
  // The profile picture panel announces changes so the top bar avatar updates at once.
  useEffect(() => {
    globalThis.addEventListener('soltrader:profile-updated', refreshMe);
    return () => globalThis.removeEventListener('soltrader:profile-updated', refreshMe);
  }, [refreshMe]);
  const signOut = async () => {
    await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    router.push('/login');
  };
  const closeMenu = () => setMenuOpen(false);
  return <div className="app-shell">
    {menuOpen && <button className="drawer-backdrop" type="button" aria-label="Close navigation" onClick={closeMenu} />}
    <aside className={`sidebar${menuOpen ? ' sidebar-open' : ''}`} aria-label="Main navigation">
      <Link href="/dashboard" className="brand" onClick={closeMenu}><span className="brand-mark"><Activity size={19} strokeWidth={2.4} /></span><div><strong>Soltrader</strong><small>TRADING TERMINAL</small></div></Link>
      <nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.items.filter((item) => !item.adminOnly || me?.data?.role === 'ADMIN').map(({ href, label, icon: Icon }) => {
        const active = pathname === `/${href}` || pathname.startsWith(`/${href}/`);
        return <Link key={href} href={`/${href}`} onClick={closeMenu} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{active && <ChevronRight className="nav-active-mark" size={14} />}</Link>;
      })}</div>)}</nav>
      <div className="sidebar-foot"><span className="mode-indicator"><i />{mode ? `${mode.replace('_', '-')} MÓD` : 'MÓD NEM ELÉRHETŐ'}</span></div>
    </aside>
    <div className="workspace">
      <header className="mobile-header"><button className="icon-button menu-trigger" type="button" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button><div className="mobile-brand"><span className="brand-mark"><Activity size={16} /></span><strong>Soltrader</strong></div><span className="mobile-page-title">{title}</span><div className="mobile-header-actions"><ThemeToggle /><ProfileMenu me={me?.data ?? null} mode={mode} onSignOut={() => void signOut()} /></div></header>
      <header className="topbar"><div className="topbar-title"><span>{title}</span></div><div className="topbar-actions"><ThemeToggle /><ProfileMenu me={me?.data ?? null} mode={mode} onSignOut={() => void signOut()} /></div></header>
      <main className="content">{children}</main>
      <StepUpDialog />
      <nav className="mobile-bottom-nav" aria-label="Quick navigation">{[{ href: 'dashboard', label: 'Főoldal', icon: LayoutDashboard }, { href: 'positions', label: 'Pozíciók', icon: List }, { href: 'new-launch', label: 'Új tokenek', icon: Rocket }, { href: 'signals', label: 'Jelzések', icon: Activity }].map(({ href, label, icon: Icon }) => <Link href={`/${href}`} key={href} className={pathname.startsWith(`/${href}`) ? 'active' : ''}><Icon size={19} /><span>{label}</span></Link>)}<button type="button" onClick={() => setMenuOpen(true)}><Menu size={19} /><span>Menü</span></button></nav>
    </div>
  </div>;
}

export function PageHeader({ eyebrow, title, subtitle, action, icon }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode; icon?: ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{translateText(eyebrow)}</p><h1 className={icon ? 'token-label' : undefined}>{icon}{translateText(title)}</h1>{subtitle && <p className="page-subtitle">{translateText(subtitle)}</p>}</div>{action}</header>;
}

export function LoadingState() { return <div className="state-panel"><span className="loader" /> Élő adatok betöltése...</div>; }
export function ErrorState({ message }: { message: string }) { return <div className="state-panel error-state">{message}</div>; }
export function EmptyState({ message }: { message: string }) { return <div className="state-panel">{message}</div>; }
/** Headline number tile; optional icon and a short note line (same look as the dashboard KPI tiles). */
export function Metric({ label, value, tone = '', icon, note }: { label: string; value: ReactNode; tone?: string; icon?: ReactNode; note?: ReactNode }) {
  return <div className={`metric${icon ? ' metric-with-icon' : ''}`}>
    <span className="metric-label">{icon ? <span className="kpi-icon" aria-hidden="true">{icon}</span> : null}{label}</span>
    <strong className={tone}>{value}</strong>
    {note ? <small className="metric-note">{note}</small> : null}
  </div>;
}
/** Titled card: optional one-line description under the title and a header action on the right. */
export function Panel({ title, children, className = '', description, action }: { title: string; children: ReactNode; className?: string; description?: ReactNode; action?: ReactNode }) {
  return <section className={`panel ${className}`}>
    <div className="panel-title"><div className="panel-title-text"><h2>{translateText(title)}</h2>{description ? <p className="panel-description">{description}</p> : null}</div>{action}</div>
    {children}
  </section>;
}
export function ModeBadge({ mode = 'UNKNOWN' }: { mode?: string }) { const names: Record<string, string> = { PAPER: 'Paper mód', LIVE: 'LIVE mód', SEMI_AUTO: 'Félautomata', SCANNER: 'Tokenfigyelő', UNKNOWN: 'Ismeretlen mód' }; return <span className={`mode-badge ${mode.toLowerCase()}`}>{names[mode] ?? mode.replaceAll('_', '-')}</span>; }
export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`status ${tone}`}>{typeof children === 'string' ? translateText(children) : children}</span>; }
/** Two-line table cell: the main value with a smaller secondary line underneath. */
export function Stacked({ top, bottom, className = '' }: { top: ReactNode; bottom?: ReactNode; className?: string }) {
  return <div className={`cell-stack ${className}`}><span>{top}</span>{bottom !== undefined && bottom !== null && bottom !== '' && <small>{bottom}</small>}</div>;
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Tables never scroll sideways: a table measures itself against its container and, when its columns do not
 * fit, switches to the labelled card layout (and back once there is room again). `wide` only marks tables
 * with many columns; the switch itself is driven by the real available width.
 */
export function DataTable({ headers, children, wide = false }: { headers: string[]; children: ReactNode; wide?: boolean }) {
  const wrapRef = useRef<globalThis.HTMLDivElement | null>(null);
  const requiredWidth = useRef(0);
  const [stacked, setStacked] = useState(false);
  const [, setMeasureTick] = useState(0);

  // Runs after every render, before paint: a table that overflows is stacked without a visible flash.
  useIsomorphicLayoutEffect(() => {
    const wrap = wrapRef.current;
    const table = wrap?.querySelector('table');
    if (!wrap || !table || stacked) return;
    if (table.scrollWidth > wrap.clientWidth + 1) {
      requiredWidth.current = table.scrollWidth;
      setStacked(true);
    }
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof globalThis.ResizeObserver === 'undefined') return;
    const observer = new globalThis.ResizeObserver(() => {
      // Wider again: try the table layout; the layout effect re-stacks if it still does not fit.
      setStacked((current) => (current && wrap.clientWidth >= requiredWidth.current ? false : current));
      setMeasureTick((tick) => tick + 1);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const labeledRows = Children.map(children, (row) => {
    if (!isValidElement<{ children?: ReactNode }>(row) || row.type !== 'tr') return row;
    let cellIndex = 0;
    const cells = Children.map(row.props.children, (cell) => {
      if (!isValidElement(cell)) return cell;
      const label = headers[cellIndex++];
      return cloneElement(cell as ReactElement<{ 'data-label'?: string }>, { 'data-label': label });
    });
    return cloneElement(row, { children: cells });
  });
  return <div className="table-wrap" ref={wrapRef}><table className={`data-table${wide ? ' wide' : ''}${stacked ? ' stacked' : ''}`}><thead><tr>{headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead><tbody>{labeledRows}</tbody></table></div>;
}
export function fmt(value: unknown, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
  // Small non-zero amounts keep enough precision to be meaningful (no "-0" or "0" for a real loss).
  const precision = value !== 0 && Math.abs(value) < 1 && digits === 2 ? 4 : digits;
  const text = value.toLocaleString('hu-HU', { maximumFractionDigits: precision });
  return /^-0([,.]0*)?$/.test(text) ? '0' : text;
}
export function formatPrice(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'N/A';
  if (value >= 1) return `$${value.toLocaleString('hu-HU', { maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 8 })}`;
}
export function date(value: unknown) { return value ? new Date(String(value)).toLocaleString('hu-HU') : 'N/A'; }
