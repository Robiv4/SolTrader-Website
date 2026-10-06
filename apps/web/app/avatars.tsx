'use client';

import { useEffect, useState, type ReactNode } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
/** Addresses without a logo in this session: not requested again (the API also caches misses). */
const missingLogos = new Set<string>();

function initialsOf(text: string | null | undefined, fallback: string) {
  const source = (text ?? '').replace(/^\$/, '').trim() || fallback;
  return source.slice(0, 2).toUpperCase();
}

/** Token logo through the API image proxy; a coloured monogram when there is no logo. */
export function TokenAvatar({ address, symbol, size = 24 }: { address?: string | null; symbol?: string | null; size?: number }) {
  const [failed, setFailed] = useState(() => !address || missingLogos.has(address));
  // Table rows are reused: re-evaluate when the token changes.
  useEffect(() => setFailed(!address || missingLogos.has(address)), [address]);
  const hue = [...(address ?? symbol ?? '?')].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 0);
  const style = { width: size, height: size, flexBasis: size, fontSize: Math.max(9, Math.round(size * 0.38)) };
  if (failed || !address) {
    return <span className="token-avatar token-avatar-fallback" style={{ ...style, background: `hsl(${hue} 55% 42%)` }} aria-hidden="true">{initialsOf(symbol, '?')}</span>;
  }
  return <img className="token-avatar" style={style} src={`${apiBase}/api/token-images/${address}`} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onError={() => {
      missingLogos.add(address);
      setFailed(true);
    }} />;
}

/** Logo + symbol on one line (used in tables and headers). */
export function TokenLabel({ address, symbol, size = 22, children }: { address?: string | null; symbol?: string | null; size?: number; children?: ReactNode }) {
  return <span className="token-label"><TokenAvatar address={address} symbol={symbol} size={size} />{children ?? <strong>{symbol ?? address?.slice(0, 6) ?? '—'}</strong>}</span>;
}

/** Profile picture (owner / admins) or initials. */
export function UserAvatar({ userId, version, name, email, size = 34, className = 'profile-avatar' }: { userId?: string | null; version?: number | null; name?: string | null; email?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const source = name?.trim() || email?.split('@')[0] || '';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? 'S') + (parts[1]?.[0] ?? parts[0]?.[1] ?? 'T')).toUpperCase();
  if (!userId || !version || failed) return <span className={className} aria-hidden="true">{initials}</span>;
  return <img className={`${className} avatar-image`} style={{ width: size, height: size }} src={`${apiBase}/api/users/${userId}/avatar?v=${version}`} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
