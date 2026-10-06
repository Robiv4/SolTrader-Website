'use client';

import { useMemo, useState } from 'react';

import { formatPrice } from './components';

export interface ChartPoint { t: number; price: number }
export interface ChartMarker { t: number; type: string; price: number | null; exitReason?: unknown }
export interface ChartLevels {
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  trailingStop: number | null;
  breakEvenActivation: number | null;
  trailingActivation: number | null;
  current: number | null;
  exit: number | null;
  baseStopLoss?: number | null;
  breakEvenStop?: number | null;
  exitTrigger?: number | null;
  exitObserved?: number | null;
}

const LEVEL_STYLE: Array<{ key: keyof ChartLevels; label: string; className: string }> = [
  { key: 'takeProfit', label: 'Take Profit', className: 'level-tp' },
  { key: 'trailingActivation', label: 'Trailing aktiválás', className: 'level-muted' },
  { key: 'breakEvenActivation', label: 'Break-even aktiválás', className: 'level-muted' },
  { key: 'current', label: 'Aktuális ár', className: 'level-current' },
  { key: 'exitTrigger', label: 'Kilépési trigger', className: 'level-trigger' },
  { key: 'exit', label: 'Tényleges kitöltés', className: 'level-current' },
  { key: 'entry', label: 'Belépés', className: 'level-entry' },
  { key: 'trailingStop', label: 'Követő stop', className: 'level-trailing' },
  { key: 'breakEvenStop', label: 'Break-even stop', className: 'level-be' },
  { key: 'stopLoss', label: 'Stop Loss', className: 'level-sl' },
  { key: 'baseStopLoss', label: 'Alap Stop Loss', className: 'level-sl level-dim' },
];

const MARKER_SYMBOL: Record<string, { symbol: string; className: string; label: string }> = {
  ENTRY: { symbol: '▲', className: 'marker-buy', label: 'VÉTEL' },
  EXIT: { symbol: '▼', className: 'marker-sell', label: 'ELADÁS' },
  TRAILING_ACTIVATED: { symbol: '●', className: 'marker-info', label: 'Trailing aktív' },
  BREAK_EVEN_APPLIED: { symbol: '●', className: 'marker-info', label: 'Break-even' },
  LIQUIDITY_WARNING: { symbol: '!', className: 'marker-warn', label: 'Likviditás' },
  TAKE_PROFIT_TOUCHED: { symbol: '◆', className: 'marker-info', label: 'TP érintve' },
};

/**
 * Line chart of REAL stored price points with horizontal exit levels and event markers. No candles or
 * interpolated prices are invented; levels come from the backend (Exit Engine state).
 */
export function PriceChart({ points, levels, markers = [], trailingSteps = [], entryPrice }: { points: ChartPoint[]; levels: ChartLevels; markers?: ChartMarker[]; trailingSteps?: ChartPoint[]; entryPrice?: number | null }) {
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const layout = useMemo(() => {
    if (points.length < 2) return null;
    const width = 1000;
    const height = 380;
    const pad = { left: 8, right: 118, top: 16, bottom: 26 };
    const tMin = points[0].t;
    const tMax = Math.max(points.at(-1)!.t, ...markers.map((marker) => marker.t));
    const levelValues = LEVEL_STYLE.map(({ key }) => levels[key]).filter((value): value is number => typeof value === 'number' && value > 0);
    const prices = [...points.map((point) => point.price), ...levelValues, ...trailingSteps.map((step) => step.price)];
    let yMin = Math.min(...prices);
    let yMax = Math.max(...prices);
    const span = yMax - yMin || yMax * 0.1 || 1;
    yMin -= span * 0.06;
    yMax += span * 0.06;
    const x = (t: number) => pad.left + (tMax > tMin ? (t - tMin) / (tMax - tMin) : 0.5) * (width - pad.left - pad.right);
    const y = (price: number) => pad.top + (1 - (price - yMin) / (yMax - yMin)) * (height - pad.top - pad.bottom);
    return { width, height, pad, tMin, tMax, x, y };
  }, [points, levels, markers, trailingSteps]);

  if (!layout) return <div className="chart-empty"><span>Nincs elég tárolt árpont a grafikonhoz</span><small>A grafikon csak valós, eltárolt piaci adatból rajzol – a hiányzó időszakot nem pótolja.</small></div>;
  const { width, height, pad, x, y, tMin, tMax } = layout;
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.price).toFixed(1)}`).join(' ');
  // Label positions: avoid overlapping labels by nudging them apart vertically.
  const labels = LEVEL_STYLE.map((style) => ({ ...style, value: levels[style.key] })).filter((level): level is typeof level & { value: number } => typeof level.value === 'number' && level.value > 0)
    .map((level) => ({ ...level, yPos: y(level.value) })).sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < labels.length; i += 1) if (labels[i].yPos - labels[i - 1].yPos < 18) labels[i].yPos = labels[i - 1].yPos + 18;
  const trailingPath = trailingSteps.length ? trailingSteps.map((step, index) => {
    const next = trailingSteps[index + 1];
    const xEnd = next ? x(next.t) : x(tMax);
    return `M${x(step.t).toFixed(1)},${y(step.price).toFixed(1)} L${xEnd.toFixed(1)},${y(step.price).toFixed(1)}`;
  }).join(' ') : '';
  const time = (t: number) => new Date(t).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const pct = (value: number) => (entryPrice ? ` (${value >= entryPrice ? '+' : ''}${((value / entryPrice - 1) * 100).toFixed(1).replace('.', ',')}%)` : '');

  return (
    <div className="price-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Árfolyam-grafikon belépési, stop loss, take profit és követő stop szintekkel"
        onMouseMove={(event) => {
          const rect = (event.currentTarget as unknown as { getBoundingClientRect(): { left: number; width: number } }).getBoundingClientRect();
          const tx = tMin + ((event.clientX - rect.left) / rect.width * width - pad.left) / (width - pad.left - pad.right) * (tMax - tMin);
          let best = points[0];
          for (const point of points) if (Math.abs(point.t - tx) < Math.abs(best.t - tx)) best = point;
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}>
        {labels.map((level) => (
          <g key={level.key} className={`chart-level ${level.className}`}>
            <line x1={pad.left} x2={width - pad.right} y1={y(level.value)} y2={y(level.value)} />
            <text x={width - pad.right + 6} y={level.yPos + 4}>{level.label}</text>
          </g>
        ))}
        {trailingPath ? <path className="chart-trailing-steps" d={trailingPath} /> : null}
        <path className="chart-line" d={path} />
        {markers.map((marker, index) => {
          const style = MARKER_SYMBOL[marker.type];
          if (!style || marker.price === null) return null;
          return <text key={`${marker.type}-${index}`} className={`chart-marker ${style.className}`} x={x(marker.t)} y={y(marker.price) + (marker.type === 'EXIT' ? -10 : 18)} textAnchor="middle"><title>{`${style.label} · ${time(marker.t)} · ${formatPrice(marker.price)}`}</title>{style.symbol}</text>;
        })}
        {hover ? <g className="chart-hover"><line x1={x(hover.t)} x2={x(hover.t)} y1={pad.top} y2={height - pad.bottom} /><circle cx={x(hover.t)} cy={y(hover.price)} r="4" /></g> : null}
        <text className="chart-axis" x={pad.left} y={height - 6}>{time(tMin)}</text>
        <text className="chart-axis" x={width - pad.right} y={height - 6} textAnchor="end">{time(tMax)}</text>
      </svg>
      <div className="chart-legend">
        {hover ? <span className="chart-hover-value">{time(hover.t)} · {formatPrice(hover.price)}</span> : <span className="annotation" style={{ margin: 0 }}>Vidd az egeret a grafikonra az árért.</span>}
        {labels.map((level) => <span key={level.key} className={`legend-item ${level.className}`}>{level.label}: {formatPrice(level.value)}{level.key !== 'entry' && level.key !== 'current' ? pct(level.value) : ''}</span>)}
      </div>
    </div>
  );
}
