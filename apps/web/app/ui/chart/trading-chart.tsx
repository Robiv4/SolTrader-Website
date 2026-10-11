'use client';

import type { IChartApi, IPriceLine, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest } from '../../components';
import { formatCompactUsd, Segmented, StatusBadge } from '../primitives';

export interface ChartCandle { t: number; o: number; h: number; l: number; c: number; v: number; n?: number }
export interface ChartMarker { t: number; kind: 'PAPER_BUY' | 'PAPER_SELL' | 'ML_BUY'; price: number | null; label: string }
export interface ChartLevels { entry: number | null; stopLoss: number | null; takeProfit: number | null; trailingStop: number | null }
export interface ChartData {
  chartType: 'candles' | 'line';
  source: 'PUMP_FUN_TRADES' | 'GECKOTERMINAL' | 'PRICE_SAMPLES';
  sourceLabel: string;
  timeframe: string | null;
  availableTimeframes: string[];
  candles?: ChartCandle[];
  points?: Array<{ t: number; price: number }>;
  gaps: Array<{ from: number; to: number }>;
  lastTradeAt: number | null;
  /** Newest stored sample before the window end, when the window itself is empty (line source only). */
  latestDataAt?: number | null;
  overlays: { markers: ChartMarker[]; levels: ChartLevels | null; positionId: string | null; simulated: boolean };
}

export const CHART_RANGES: Array<{ id: string; label: string; ms: number }> = [
  { id: '15m', label: '15p', ms: 15 * 60_000 },
  { id: '1h', label: '1ó', ms: 3_600_000 },
  { id: '6h', label: '6ó', ms: 6 * 3_600_000 },
  { id: '24h', label: '24ó', ms: 24 * 3_600_000 },
  { id: '7d', label: '7n', ms: 7 * 86_400_000 },
];
const TIMEFRAME_LABELS: Record<string, string> = { '5s': '5mp', '15s': '15mp', '1m': '1p', '5m': '5p', '15m': '15p', '1h': '1ó' };
const REFRESH_MS = 5_000;

/** Plain price text for the axis / legend; tiny prices keep their significant digits (0.0₅4123). */
export function formatAxisPrice(value: number) {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const match = /^0\.(0+)(\d+)/.exec(abs.toFixed(20));
  if (!match || match[1].length < 4) return value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 5 });
  const subscript = String(match[1].length).split('').map((digit) => '₀₁₂₃₄₅₆₇₈₉'[Number(digit)]).join('');
  return `${value < 0 ? '-' : ''}0.0${subscript}${match[2].slice(0, 4)}`;
}

function cssVar(name: string, fallback: string) {
  if (typeof globalThis.document === 'undefined') return fallback;
  return globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue(name).trim() || fallback;
}

function themeColors() {
  return {
    text: cssVar('--muted', '#8b94a6'), grid: cssVar('--border-soft', 'rgba(148,163,199,0.08)'), border: cssVar('--border', '#1f2633'),
    up: cssVar('--up', '#2fd492'), down: cssVar('--down', '#ff5c72'), brand: cssVar('--brand', '#8b80ff'), warning: cssVar('--warning', '#f5b84a'), info: cssVar('--info', '#6ea8ff'), trailing: cssVar('--trailing', '#ff9a4d'),
  };
}

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const localTime = (time: Time, withSeconds: boolean) => new Date(Number(time) * 1000).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });

const legendTime = (t: number) => (Date.now() - t > 20 * 3_600_000 ? new Date(t).toLocaleString('hu-HU') : new Date(t).toLocaleTimeString('hu-HU'));

type Legend = { t: number; o?: number; h?: number; l?: number; c?: number; v?: number; price?: number } | null;

/** Chart data for one token: the API decides honestly between real OHLCV and a price line; polled while visible. */
export function useTokenChart(address: string, rangeMs: number, timeframe: string | null, anchorTo: number | null = null) {
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const load = useCallback(async () => {
    const to = anchorTo ?? Date.now();
    try {
      const response = await apiRequest<{ data: ChartData }>(`/api/tokens/${address}/candles?from=${to - rangeMs}&to=${to}${timeframe ? `&tf=${timeframe}` : ''}`);
      setData(response.data);
      setError(null);
      setFetchedAt(Date.now());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'A grafikon adatai nem tölthetők be');
    } finally {
      setLoading(false);
    }
  }, [address, rangeMs, timeframe, anchorTo]);
  useEffect(() => {
    setLoading(true);
    void load();
    // Live refresh only for short, non-historical ranges and while the tab is visible (cheap Redis / cached reads server-side).
    if (rangeMs > 24 * 3_600_000 || anchorTo !== null) return undefined;
    const timer = globalThis.setInterval(() => {
      if (!globalThis.document.hidden) void load();
    }, REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [load, rangeMs, anchorTo]);
  return { data, error, loading, fetchedAt };
}

/**
 * Trading chart (TradingView Lightweight Charts): candles + volume for real OHLCV, otherwise a price line. Zoom / pan,
 * crosshair legend, PAPER entry / exit and ML BUY markers and the open position's entry / SL / TP / trailing lines.
 */
export function TradingChart({ address, height = 440 }: { address: string; height?: number }) {
  const [range, setRange] = useState('1h');
  const [timeframe, setTimeframe] = useState<string | null>(null);
  /** Window end for browsing older stored data; null = live (now). */
  const [anchorTo, setAnchorTo] = useState<number | null>(null);
  const rangeMs = CHART_RANGES.find((item) => item.id === range)?.ms ?? 3_600_000;
  const { data, error, loading, fetchedAt } = useTokenChart(address, rangeMs, timeframe, anchorTo);
  const container = useRef<globalThis.HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; price: ISeriesApi<'Candlestick'> | ISeriesApi<'Area'>; volume: ISeriesApi<'Histogram'> | null; lines: IPriceLine[]; type: string } | null>(null);
  const [legend, setLegend] = useState<Legend>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [ready, setReady] = useState(0);
  const fitKey = useRef('');

  // Re-color on theme switch.
  useEffect(() => {
    const observer = new globalThis.MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // (Re)build the chart when the chart type or theme changes.
  useEffect(() => {
    if (!container.current || !data) return undefined;
    let disposed = false;
    const element = container.current;
    void import('lightweight-charts').then(({ createChart, CrosshairMode, ColorType }) => {
      if (disposed) return;
      chartRef.current?.chart.remove();
      const colors = themeColors();
      const fine = data.chartType === 'candles' && (data.timeframe === '5s' || data.timeframe === '15s');
      const chart = createChart(element, {
        height, autoSize: true,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontFamily: 'var(--font-code), JetBrains Mono, monospace', fontSize: 11 },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.08, bottom: data.chartType === 'candles' ? 0.24 : 0.08 } },
        timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: fine, rightOffset: 4, tickMarkFormatter: (time: Time) => localTime(time, fine) },
        crosshair: { mode: CrosshairMode.Normal },
        localization: { locale: 'hu-HU', priceFormatter: formatAxisPrice, timeFormatter: (time: Time) => new Date(Number(time) * 1000).toLocaleString('hu-HU') },
      });
      const priceFormat = { type: 'custom' as const, formatter: formatAxisPrice, minMove: 1e-12 };
      const price = data.chartType === 'candles'
        ? chart.addCandlestickSeries({ upColor: colors.up, downColor: colors.down, borderUpColor: colors.up, borderDownColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down, priceFormat })
        : chart.addAreaSeries({ lineColor: colors.brand, topColor: `${colors.brand}40`, bottomColor: `${colors.brand}00`, lineWidth: 2, priceFormat });
      const volume = data.chartType === 'candles' ? chart.addHistogramSeries({ priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }) : null;
      if (volume) chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      chart.subscribeCrosshairMove((param) => {
        if (!param.time) {
          setLegend(null);
          return;
        }
        const value = param.seriesData.get(price) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined;
        const vol = volume ? (param.seriesData.get(volume) as { value?: number } | undefined)?.value : undefined;
        setLegend(value ? { t: Number(param.time) * 1000, o: value.open, h: value.high, l: value.low, c: value.close, price: value.value, v: vol } : null);
      });
      chartRef.current = { chart, price, volume, lines: [], type: data.chartType };
      fitKey.current = '';
      setReady((value) => value + 1);
    });
    return () => {
      disposed = true;
    };
  }, [data?.chartType, data?.timeframe, themeTick, height, Boolean(data)]);

  useEffect(() => () => {
    chartRef.current?.chart.remove();
    chartRef.current = null;
  }, []);

  // Push data, markers and levels into the existing chart (no page re-render of the chart itself).
  useEffect(() => {
    const current = chartRef.current;
    if (!current || !data || current.type !== data.chartType) return;
    const colors = themeColors();
    if (data.chartType === 'candles') {
      const candles = data.candles ?? [];
      (current.price as ISeriesApi<'Candlestick'>).setData(candles.map((candle) => ({ time: toTime(candle.t), open: candle.o, high: candle.h, low: candle.l, close: candle.c })));
      current.volume?.setData(candles.map((candle) => ({ time: toTime(candle.t), value: candle.v, color: candle.c >= candle.o ? `${colors.up}55` : `${colors.down}55` })));
    } else {
      const points = data.points ?? [];
      const gapStarts = new Set(data.gaps.map((gap) => gap.from));
      // Whitespace right after a gap start breaks the line instead of drawing across missing data.
      const series: Array<{ time: UTCTimestamp; value?: number }> = [];
      for (const point of points) {
        series.push({ time: toTime(point.t), value: point.price });
        if (gapStarts.has(point.t)) series.push({ time: (toTime(point.t) + 1) as UTCTimestamp });
      }
      const unique = series.filter((item, index) => index === 0 || item.time > series[index - 1].time);
      (current.price as ISeriesApi<'Area'>).setData(unique);
    }
    const shown = new Set((data.candles ?? data.points ?? []).map((item) => toTime(item.t)));
    const first = data.candles?.[0]?.t ?? data.points?.[0]?.t ?? null;
    const markers: Array<SeriesMarker<Time>> = data.overlays.markers.filter((marker) => first !== null && marker.t >= first).map((marker) => ({
      time: nearestTime(toTime(marker.t), shown),
      position: marker.kind === 'PAPER_SELL' ? 'aboveBar' : 'belowBar',
      color: marker.kind === 'PAPER_BUY' ? colors.up : marker.kind === 'PAPER_SELL' ? colors.down : colors.brand,
      shape: marker.kind === 'PAPER_SELL' ? 'arrowDown' : marker.kind === 'PAPER_BUY' ? 'arrowUp' : 'circle',
      text: marker.kind === 'ML_BUY' ? 'ML' : marker.kind === 'PAPER_BUY' ? 'P·VÉTEL' : 'P·ELADÁS',
    }));
    current.price.setMarkers(markers.sort((a, b) => Number(a.time) - Number(b.time)));
    for (const line of current.lines) current.price.removePriceLine(line);
    current.lines = [];
    const levels = data.overlays.levels;
    if (levels) {
      const add = (value: number | null, title: string, color: string, style: number) => {
        if (value !== null && value > 0) current.lines.push(current.price.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
      };
      add(levels.entry, 'Belépés (PAPER)', colors.info, 0);
      add(levels.stopLoss, 'SL', colors.down, 2);
      add(levels.takeProfit, 'TP', colors.up, 2);
      add(levels.trailingStop, 'Trailing', colors.trailing, 1);
    }
    const key = `${address}:${range}:${data.timeframe}:${data.chartType}:${anchorTo ?? 'live'}`;
    if (fitKey.current !== key) {
      current.chart.timeScale().fitContent();
      fitKey.current = key;
    }
  }, [data, address, range, ready, anchorTo]);

  const lastAge = data?.lastTradeAt ? Date.now() - data.lastTradeAt : null;
  const status = anchorTo !== null && !error ? { tone: 'info' as const, text: 'Korábbi adatok' } : error && !data ? { tone: 'negative' as const, text: 'Kapcsolat megszakadt' } : error ? { tone: 'warning' as const, text: 'Frissítés sikertelen' }
    : lastAge !== null && lastAge < 60_000 ? { tone: 'positive' as const, text: 'Élő' } : { tone: 'neutral' as const, text: lastAge === null ? 'Nincs adat' : 'Nem friss' };
  const latest = data?.chartType === 'candles' ? data.candles?.at(-1) : null;
  const shownLegend: Legend = legend ?? (latest ? { t: latest.t, o: latest.o, h: latest.h, l: latest.l, c: latest.c, v: latest.v } : data?.points?.length ? { t: data.points.at(-1)!.t, price: data.points.at(-1)!.price } : null);
  const timeframes = useMemo(() => (data?.availableTimeframes ?? []).map((id) => ({ id, label: TIMEFRAME_LABELS[id] ?? id })), [data?.availableTimeframes]);

  return <section className="tchart" aria-label="Árfolyamgrafikon">
    <div className="tchart-toolbar">
      <Segmented label="Időtáv" value={range} onChange={(id) => setRange(id)} options={CHART_RANGES.map((item) => ({ id: item.id, label: item.label }))} />
      {timeframes.length ? <Segmented label="Gyertya mérete" value={data?.timeframe ?? timeframes[0].id} onChange={(id) => setTimeframe(id)} options={timeframes} /> : null}
      <span className="tchart-spacer" />
      {anchorTo !== null ? <button type="button" className="link-button" onClick={() => setAnchorTo(null)}>Vissza az élő nézethez</button> : null}
      <StatusBadge tone={status.tone} dot>{status.text}</StatusBadge>
    </div>
    <div className="tchart-legend" aria-live="off">
      {shownLegend ? (shownLegend.o !== undefined
        ? <><span>{legendTime(shownLegend.t)}</span><span>O <b>{formatAxisPrice(shownLegend.o)}</b></span><span>H <b>{formatAxisPrice(shownLegend.h ?? 0)}</b></span><span>L <b>{formatAxisPrice(shownLegend.l ?? 0)}</b></span><span>C <b className={(shownLegend.c ?? 0) >= shownLegend.o ? 'up' : 'down'}>{formatAxisPrice(shownLegend.c ?? 0)}</b></span>{shownLegend.v !== undefined ? <span>Vol <b>{formatCompactUsd(shownLegend.v)}</b></span> : null}</>
        : <><span>{legendTime(shownLegend.t)}</span><span>Ár <b>{formatAxisPrice(shownLegend.price ?? 0)}</b> USD</span></>) : <span>&nbsp;</span>}
    </div>
    <div className="tchart-canvas" ref={container} style={{ height }}>
      {loading && !data ? <div className="tchart-overlay"><span className="skeleton" style={{ width: '100%', height: '100%', borderRadius: 8 }} /></div> : null}
      {data && !(data.candles?.length || data.points?.length) ? <div className="tchart-overlay"><p>Ebben az időtávban nincs tárolt árfolyamadat.</p>
        {data.latestDataAt ? <button type="button" className="secondary-button small" onClick={() => setAnchorTo(Math.min(Date.now(), data.latestDataAt! + Math.round(rangeMs * 0.1)))}>Ugrás az utolsó adathoz ({new Date(data.latestDataAt).toLocaleString('hu-HU')})</button> : null}
      </div> : null}
      {error && !data ? <div className="tchart-overlay"><p>{error}</p></div> : null}
    </div>
    <footer className="tchart-foot">
      <span>Forrás: {data?.sourceLabel ?? '—'}{data?.chartType === 'line' ? ' · vonaldiagram' : ''}</span>
      {data?.gaps.length ? <span className="warn-text">{data.gaps.length} adatrés az időtávban</span> : null}
      {data?.overlays.markers.length || data?.overlays.levels ? <span>Jelölések: PAPER (szimulált) kötések{data?.overlays.markers.some((marker) => marker.kind === 'ML_BUY') ? ', ML BUY' : ''}</span> : null}
      <span className="muted">{fetchedAt ? `frissítve ${new Date(fetchedAt).toLocaleTimeString('hu-HU')}` : ''}</span>
    </footer>
  </section>;
}

/** Markers snap to the closest drawn bar (lightweight-charts needs an existing time). */
function nearestTime(time: UTCTimestamp, shown: Set<UTCTimestamp>): Time {
  if (shown.has(time) || !shown.size) return time;
  let best = time;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of shown) {
    const delta = Math.abs(candidate - time);
    if (delta < distance) {
      best = candidate;
      distance = delta;
    }
  }
  return best;
}
