/* eslint-disable @typescript-eslint/no-explicit-any */
import { fmt, formatPrice } from './components';

export function holdingTime(fromValue: string | Date | null | undefined, toValue?: string | Date | null) {
  if (!fromValue) return '—';
  const ms = Math.max(0, (toValue ? new Date(toValue).getTime() : Date.now()) - new Date(fromValue).getTime());
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} mp`;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} perc`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} ó ${minutes % 60} p`;
  return `${Math.floor(minutes / 1440)} nap ${Math.floor(minutes % 1440 / 60)} ó`;
}

export const signedPercent = (value: number | null | undefined) => (value == null ? '—' : `${value > 0 ? '+' : ''}${fmt(value, 1)}%`);

export function trailingSummary(exit: any) {
  if (!exit || exit.trailingStatus === 'OFF') return 'nincs';
  if (exit.trailingStatus === 'ACTIVE') return `AKTÍV @ ${formatPrice(exit.trailingTriggerPrice)}`;
  return `VÁR +${fmt(exit.trailingActivationPercent ?? 0, 0)}%`;
}
