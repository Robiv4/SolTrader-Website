'use client';

import { Check, Copy, Search, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export type Tone = 'positive' | 'negative' | 'warning' | 'info' | 'brand' | 'neutral';

/** Small coloured state label (BUY / WATCH / REJECT, LIVE / STALE, ...). One look everywhere. */
export function StatusBadge({ tone = 'neutral', children, dot = false, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{dot ? <i className="badge-dot" aria-hidden="true" /> : null}{children}</span>;
}

export interface TabItem<T extends string> { id: T; label: string; count?: number | null; disabled?: boolean }

/** Accessible tab bar (roving selection, horizontal scroll on small screens). */
export function TabNavigation<T extends string>({ tabs, active, onChange, label }: { tabs: Array<TabItem<T>>; active: T; onChange: (id: T) => void; label: string }) {
  return <div className="tabnav" role="tablist" aria-label={label}>
    {tabs.map((tab) => <button key={tab.id} type="button" role="tab" id={`tab-${tab.id}`} aria-selected={active === tab.id} aria-controls={`panel-${tab.id}`} disabled={tab.disabled}
      className={`tabnav-item${active === tab.id ? ' active' : ''}`} onClick={() => onChange(tab.id)}>
      {tab.label}{typeof tab.count === 'number' ? <span className="tabnav-count">{tab.count}</span> : null}
    </button>)}
  </div>;
}

/** Shimmering placeholder while data loads (keeps the layout stable). */
export function Skeleton({ width = '100%', height = 14, radius = 6, className = '' }: { width?: number | string; height?: number | string; radius?: number; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

/** A block of skeleton rows (table / list placeholder). */
export function SkeletonRows({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return <div className="skeleton-rows" role="status" aria-label="Betöltés">
    {Array.from({ length: rows }, (_, row) => <div key={row} className="skeleton-row">{Array.from({ length: columns }, (_, col) => <Skeleton key={col} width={col === 0 ? '28%' : `${12 + ((row + col) % 3) * 4}%`} />)}</div>)}
  </div>;
}

export interface FilterChip<T extends string> { id: T; label: string; count?: number }

/** Search + chip filters + optional extra controls on one row. */
export function FilterBar<T extends string>({ query, onQuery, placeholder, chips, activeChip, onChip, children }: {
  query: string; onQuery: (value: string) => void; placeholder: string;
  chips?: Array<FilterChip<T>>; activeChip?: T; onChip?: (id: T) => void; children?: ReactNode;
}) {
  return <div className="filterbar">
    <label className="filterbar-search"><Search size={16} aria-hidden="true" />
      <input type="search" value={query} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onQuery(event.target.value)} />
      {query ? <button type="button" className="filterbar-clear" aria-label="Keresés törlése" onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    {chips && onChip ? <div className="chip-group" role="group" aria-label="Szűrő">
      {chips.map((chip) => <button key={chip.id} type="button" className={`chip${activeChip === chip.id ? ' active' : ''}`} aria-pressed={activeChip === chip.id} onClick={() => onChip(chip.id)}>
        {chip.label}{typeof chip.count === 'number' ? <span className="chip-count">{chip.count}</span> : null}
      </button>)}
    </div> : null}
    {children}
  </div>;
}

/** Segmented control for a small set of mutually exclusive options (time range, view, ...). */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: Array<{ id: T; label: string; disabled?: boolean; title?: string }>; value: T; onChange: (id: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>
    {options.map((option) => <button key={option.id} type="button" className={value === option.id ? 'active' : ''} aria-pressed={value === option.id} disabled={option.disabled} title={option.title} onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>;
}

/** Copies text to the clipboard; announces the result for screen readers. */
export function CopyButton({ text, label = 'Másolás', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className={`copy-btn${compact ? ' compact' : ''}`} onClick={() => void copy()} aria-label={label} title={label}>
    {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{compact ? null : <span>{copied ? 'Kimásolva' : label}</span>}
    <span className="sr-only" role="status" aria-live="polite">{copied ? 'Kimásolva' : ''}</span>
  </button>;
}

/** Label / value list for compact side panels. */
export function KeyValueList({ items }: { items: Array<[string, ReactNode] | null | false> }) {
  return <dl className="kv">{items.filter((item): item is [string, ReactNode] => Boolean(item)).map(([key, value]) => <div key={key} className="kv-row"><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}

/** Shortened public key: 7xAb…9KdP. */
export function shortAddress(address: string | null | undefined, head = 4, tail = 4) {
  if (!address) return '—';
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Price with enough significant digits for micro-priced tokens: $0.0₅4123 style subscript zeros. */
export function formatTokenPrice(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  const text = value.toFixed(20);
  const match = /^0\.(0+)(\d+)/.exec(text);
  if (!match || match[1].length < 4) return `$${value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 5 })}`;
  const zeros = match[1].length;
  const digits = match[2].slice(0, 4).replace(/0+$/, '') || '0';
  const subscript = String(zeros).split('').map((digit) => '₀₁₂₃₄₅₆₇₈₉'[Number(digit)]).join('');
  return `$0.0${subscript}${digits}`;
}

/** Compact USD: $12.4K, $1.2M (never invents a value). */
export function formatCompactUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(abs >= 100 ? 0 : 2)}`;
}

export function formatSignedPercent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function toneOf(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
}

/** Age in Hungarian short units. */
export function formatAge(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)} mp`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} p`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} ó ${Math.floor((seconds % 3600) / 60)} p`;
  return `${Math.floor(seconds / 86_400)} nap`;
}
