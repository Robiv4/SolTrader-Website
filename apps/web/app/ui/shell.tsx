'use client';

import {
  Activity, BarChart3, BrainCircuit, ChevronDown, ChevronRight, History, LayoutDashboard, Layers, ListTree, Menu, Rocket, ScrollText, Settings2, ShieldCheck,
  Users, Wallet, X, type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ProfileMenu, ThemeToggle } from '../topbar';

import { StatusBadge, type Tone } from './primitives';
import { WalletButton } from './wallet/wallet-button';

export interface NavItem { href: string; label: string; icon: LucideIcon; adminOnly?: boolean }
export interface NavGroup { id: string; label: string; items: NavItem[]; collapsible?: boolean }

/** Main navigation (the retired token scanner has no entry). */
export const NAV_GROUPS: NavGroup[] = [
  { id: 'overview', label: 'Áttekintés', items: [{ href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  { id: 'trading', label: 'Kereskedés', items: [
    { href: 'new-launch', label: 'Új tokenek', icon: Rocket },
    { href: 'positions', label: 'Pozíciók', icon: Layers },
    { href: 'trades', label: 'Kereskedési előzmények', icon: History },
    { href: 'signals', label: 'Jelzések', icon: Activity },
  ] },
  { id: 'insights', label: 'Elemzés', items: [{ href: 'analytics', label: 'Analitika', icon: BarChart3 }, { href: 'machine-learning', label: 'Machine Learning', icon: BrainCircuit }] },
  { id: 'account', label: 'Fiók', items: [{ href: 'wallet', label: 'Tárca', icon: Wallet }, { href: 'settings', label: 'Beállítások', icon: Settings2 }] },
  { id: 'system', label: 'Rendszer', collapsible: true, items: [
    { href: 'system', label: 'Rendszerállapot', icon: ShieldCheck },
    { href: 'logs', label: 'Naplók', icon: ScrollText },
    { href: 'users', label: 'Felhasználók', icon: Users, adminOnly: true },
  ] },
];

const DETAIL_LABELS: Record<string, string> = { tokens: 'Token', positions: 'Pozíció', trades: 'Kereskedés' };
const DETAIL_PARENT: Record<string, string> = { tokens: 'new-launch' };

/** Page title + breadcrumb trail for the current path. */
export function routeTrail(pathname: string): { title: string; trail: Array<{ label: string; href?: string }> } {
  const [first, second] = pathname.split('/').filter(Boolean);
  const parentHref = DETAIL_PARENT[first] ?? first;
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => entry.href === parentHref);
    if (!item) continue;
    if (second) return { title: DETAIL_LABELS[first] ?? item.label, trail: [{ label: group.label }, { label: item.label, href: `/${item.href}` }, { label: DETAIL_LABELS[first] ?? 'Részletek' }] };
    return { title: item.label, trail: [{ label: group.label }, { label: item.label }] };
  }
  return { title: 'SolTrader', trail: [] };
}

const COLLAPSE_KEY = 'soltrader-nav-collapsed';

export function Sidebar({ pathname, isAdmin, open, onNavigate }: { pathname: string; isAdmin: boolean; open: boolean; onNavigate: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ system: true });
  useEffect(() => {
    try {
      const stored = globalThis.localStorage.getItem(COLLAPSE_KEY);
      if (stored) setCollapsed(JSON.parse(stored) as Record<string, boolean>);
    } catch {
      // storage unavailable: defaults
    }
  }, []);
  const toggle = (id: string) => setCollapsed((current) => {
    const next = { ...current, [id]: !current[id] };
    try {
      globalThis.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    return next;
  });
  return <aside className={`sidebar${open ? ' sidebar-open' : ''}`} aria-label="Fő navigáció">
    <Link href="/dashboard" className="brand" onClick={onNavigate}>
      <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 16.5 9 11l3.5 3.5L20 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 7h5v5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      <span className="brand-text"><strong>SolTrader</strong><small>Solana terminál</small></span>
    </Link>
    <nav className="nav">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => !item.adminOnly || isAdmin);
        const hasActive = items.some((item) => pathname === `/${item.href}` || pathname.startsWith(`/${item.href}/`));
        const isCollapsed = group.collapsible && collapsed[group.id] && !hasActive;
        return <div className="nav-group" key={group.id}>
          {group.collapsible
            ? <button type="button" className="nav-group-label toggle" aria-expanded={!isCollapsed} onClick={() => toggle(group.id)}>{group.label}{isCollapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}</button>
            : <span className="nav-group-label">{group.label}</span>}
          {isCollapsed ? null : items.map(({ href, label, icon: Icon }) => {
            const active = pathname === `/${href}` || pathname.startsWith(`/${href}/`) || (href === 'new-launch' && pathname.startsWith('/tokens/'));
            return <Link key={href} href={`/${href}`} onClick={onNavigate} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}><Icon size={17} strokeWidth={1.9} aria-hidden="true" /><span>{label}</span></Link>;
          })}
        </div>;
      })}
    </nav>
    <div className="sidebar-foot"><ListTree size={13} aria-hidden="true" /> PAPER kereskedés · LIVE tiltva</div>
  </aside>;
}

export interface ShellStatus { tradingMode?: string; botStatus?: string; isEmergencyStop?: boolean; paperStrategy?: { mode: string; modelVersion: string | null } }

const BOT_LABEL: Record<string, string> = { RUNNING: 'Fut', PAUSED: 'Szünetel', STOPPED: 'Leállítva', EMERGENCY_STOP: 'Vészleállítás' };

/** Bot / trading-mode pill: PAPER (or the real mode) + bot state + entry strategy, in one readable chip. */
export function BotStatusPill({ status }: { status: ShellStatus | null }) {
  if (!status?.tradingMode) return <span className="status-pill"><span className="skeleton" style={{ width: 92, height: 14, borderRadius: 6 }} /></span>;
  const emergency = Boolean(status.isEmergencyStop);
  const running = status.botStatus === 'RUNNING' && !emergency;
  const tone: Tone = emergency ? 'negative' : running ? 'positive' : 'warning';
  const strategy = status.paperStrategy?.mode === 'ML' ? 'ML' : 'Alap';
  return <Link href="/settings#bot" className={`status-pill tone-${tone}`} title={`Kereskedési mód: ${status.tradingMode} · Bot: ${BOT_LABEL[status.botStatus ?? ''] ?? status.botStatus} · Stratégia: ${strategy}`}>
    <StatusBadge tone={status.tradingMode === 'PAPER' ? 'brand' : 'warning'}>{status.tradingMode.replace('_', '-')}</StatusBadge>
    <span className={`conn-dot ${emergency ? 'error' : running ? 'live' : 'stale'}`} aria-hidden="true" />
    <span className="status-pill-text">{emergency ? 'Vészleállítás' : BOT_LABEL[status.botStatus ?? ''] ?? 'Ismeretlen'}</span>
    <span className="status-pill-strategy">{strategy}</span>
  </Link>;
}

type Me = { id?: string; email: string; name: string | null; role: string; avatarVersion?: number | null };

export function Topbar({ pathname, status, me, onMenu, menuOpen, onSignOut }: { pathname: string; status: ShellStatus | null; me: Me | null; onMenu: () => void; menuOpen: boolean; onSignOut: () => void }) {
  const { title, trail } = routeTrail(pathname);
  return <header className="topbar">
    <button className="icon-btn menu-trigger" type="button" aria-label={menuOpen ? 'Menü bezárása' : 'Menü megnyitása'} onClick={onMenu}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
    <div className="topbar-title">
      {trail.length ? <nav aria-label="Navigációs útvonal" className="crumbs">{trail.map((crumb, index) => <span key={`${crumb.label}-${index}`}>{crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : crumb.label}{index < trail.length - 1 ? <ChevronRight size={12} aria-hidden="true" /> : null}</span>)}</nav> : null}
      <h1>{title}</h1>
    </div>
    <div className="topbar-actions">
      <BotStatusPill status={status} />
      <WalletButton />
      <ThemeToggle />
      <ProfileMenu me={me} mode={status?.tradingMode} onSignOut={onSignOut} />
    </div>
  </header>;
}

const MOBILE_NAV: NavItem[] = [
  { href: 'dashboard', label: 'Főoldal', icon: LayoutDashboard },
  { href: 'new-launch', label: 'Új tokenek', icon: Rocket },
  { href: 'positions', label: 'Pozíciók', icon: Layers },
  { href: 'wallet', label: 'Tárca', icon: Wallet },
];

export function MobileNav({ pathname, onMenu }: { pathname: string; onMenu: () => void }) {
  return <nav className="mobile-nav" aria-label="Gyors navigáció">
    {MOBILE_NAV.map(({ href, label, icon: Icon }) => <Link href={`/${href}`} key={href} className={pathname.startsWith(`/${href}`) ? 'active' : ''}><Icon size={19} aria-hidden="true" /><span>{label}</span></Link>)}
    <button type="button" onClick={onMenu}><Menu size={19} aria-hidden="true" /><span>Menü</span></button>
  </nav>;
}
