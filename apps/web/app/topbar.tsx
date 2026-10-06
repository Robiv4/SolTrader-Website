'use client';

import { ChevronDown, LogOut, Moon, Settings2, Sun } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { UserAvatar } from './avatars';
import { THEME_STORAGE_KEY } from './theme-script';

export type Theme = 'light' | 'dark';
function currentTheme(): Theme {
  return typeof globalThis.document !== 'undefined' && globalThis.document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => setTheme(currentTheme()), []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const toggle = () => {
    globalThis.document.documentElement.setAttribute('data-theme', next);
    try {
      globalThis.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
    setTheme(next);
  };
  const label = next === 'dark' ? 'Váltás sötét módra' : 'Váltás világos módra';
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={label} title={label}>
      <span className={`theme-toggle-option${theme === 'light' ? ' active' : ''}`} aria-hidden="true"><Sun size={17} /></span>
      <span className={`theme-toggle-option${theme === 'dark' ? ' active' : ''}`} aria-hidden="true"><Moon size={17} /></span>
    </button>
  );
}

type Me = { id?: string; email: string; name: string | null; role: string; avatarVersion?: number | null };

/** Avatar + name in the top-right corner; opens a small menu with settings and sign out. */
export function ProfileMenu({ me, mode, onSignOut }: { me: Me | null; mode: string | undefined; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<globalThis.HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.Event) => {
      if (event instanceof globalThis.KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as globalThis.Node)) setOpen(false);
    };
    globalThis.document.addEventListener('mousedown', close);
    globalThis.document.addEventListener('keydown', close);
    return () => {
      globalThis.document.removeEventListener('mousedown', close);
      globalThis.document.removeEventListener('keydown', close);
    };
  }, [open]);
  const displayName = me?.name?.trim() || 'Kereskedési fiók';
  return (
    <div className="profile-menu" ref={root}>
      <button type="button" className="profile-card" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <UserAvatar userId={me?.id} version={me?.avatarVersion} name={me?.name} email={me?.email} size={38} />
        <span className="profile-text">
          <strong>{displayName}</strong>
          <small>{me?.email ?? '…'}</small>
        </span>
        <ChevronDown className="profile-chevron" size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="profile-dropdown" role="menu">
          <div className="profile-dropdown-head">
            <UserAvatar userId={me?.id} version={me?.avatarVersion} name={me?.name} email={me?.email} size={48} className="profile-avatar large" />
            <div>
              <strong>{displayName}</strong>
              <small>{me?.email}</small>
              <span className="profile-badges">
                <span className="profile-badge mode">{mode ? `${mode.replace('_', '-')} mód` : 'mód ismeretlen'}</span>
                {me?.role === 'ADMIN' ? <span className="profile-badge">Admin</span> : null}
              </span>
            </div>
          </div>
          <Link role="menuitem" href="/settings" className="profile-dropdown-item" onClick={() => setOpen(false)}><Settings2 size={17} aria-hidden="true" /> Beállítások</Link>
          <button role="menuitem" type="button" className="profile-dropdown-item danger" onClick={() => { setOpen(false); onSignOut(); }}><LogOut size={17} aria-hidden="true" /> Kijelentkezés</button>
        </div>
      ) : null}
    </div>
  );
}
