import type { ReactNode } from 'react';

/** Headline number tile with an icon (dashboard, positions, token detail). */
export function Kpi({ icon, label, value, sub, note, tone = '' }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; note?: ReactNode; tone?: string }) {
  return <div className={`kpi${tone ? ` kpi-${tone}` : ''}`}>
    <div className="kpi-head"><span className="kpi-icon" aria-hidden="true">{icon}</span><span className="kpi-label">{label}</span></div>
    <strong className="kpi-value">{value}</strong>
    {sub ? <span className="kpi-sub">{sub}</span> : null}
    {note ? <span className="kpi-note">{note}</span> : null}
  </div>;
}

/** Titled content card with an optional short description and a header action (link, filter, button). */
export function DashCard({ title, description, action, children, className = '' }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`scard dash-card ${className}`}>
    <header className="scard-head dash-card-head"><div><h3>{title}</h3>{description ? <p>{description}</p> : null}</div>{action}</header>
    <div className="scard-body">{children}</div>
  </section>;
}

/** Label / value list used in summary cards. */
export function StatList({ items }: { items: Array<[ReactNode, ReactNode] | null | false> }) {
  return <dl className="dash-stat-list">{items.filter(Boolean).map((item, index) => {
    const [term, value] = item as [ReactNode, ReactNode];
    return <div key={index}><dt>{term}</dt><dd>{value}</dd></div>;
  })}</dl>;
}

/** 0-100 score as a labelled horizontal bar (value is also shown as text, never color only). */
export function ScoreBar({ label, value, invert = false }: { label: string; value: number | null | undefined; invert?: boolean }) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const score = known ? Math.max(0, Math.min(100, value)) : 0;
  const good = invert ? 100 - score : score;
  const tone = !known ? 'muted' : good >= 65 ? 'good' : good >= 40 ? 'mid' : 'bad';
  return <div className="score-bar">
    <div className="score-bar-head"><span>{label}</span><strong>{known ? Math.round(score) : '—'}</strong></div>
    <div className="score-bar-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(score) : undefined}><span className={`score-bar-fill ${tone}`} style={{ width: `${score}%` }} /></div>
  </div>;
}
