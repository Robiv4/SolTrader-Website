'use client';

import Link from 'next/link';

import { TokenAvatar } from '../../avatars';
import { CopyButton, formatAge, formatCompactUsd, formatSignedPercent, formatTokenPrice, shortAddress, StatusBadge, toneOf } from '../primitives';

import { SOURCE_LABELS, type TokenDetail } from './token-types';

function freshness(iso: string | null) {
  if (!iso) return { text: 'ismeretlen', tone: 'neutral' as const };
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return { text: `${Math.round(seconds)} mp-e`, tone: 'positive' as const };
  if (seconds < 900) return { text: `${Math.round(seconds / 60)} perce`, tone: 'warning' as const };
  return { text: new Date(iso).toLocaleString('hu-HU'), tone: 'neutral' as const };
}

/** Token identity + headline market data (one row on desktop, wrapping on mobile). */
export function TokenHeader({ token }: { token: TokenDetail }) {
  const launch = token.launch;
  const source = launch ? SOURCE_LABELS[launch.source] ?? launch.source : token.dexId ?? null;
  const changeSinceDetection = launch?.detectedPriceUsd && token.priceUsd ? (token.priceUsd / launch.detectedPriceUsd - 1) * 100 : null;
  const updated = freshness(token.lastUpdatedAt);
  const age = launch?.ageSeconds ?? token.tokenAgeSeconds;
  return <header className="token-header">
    <div className="token-id">
      <TokenAvatar address={token.address} symbol={token.symbol ?? token.address} size={44} />
      <div className="token-id-text">
        <div className="token-id-name"><h2 title={token.name ?? undefined}>{token.symbol ?? shortAddress(token.address)}</h2>{token.name ? <span className="token-fullname">{token.name}</span> : null}</div>
        <div className="token-id-meta">
          <span className="mono" title={token.address}>{shortAddress(token.address, 5, 5)}</span><CopyButton text={token.address} label="Mint cím másolása" compact />
          {source ? <StatusBadge tone="brand">{source}</StatusBadge> : null}
          {age !== null && age !== undefined ? <span className="muted">{formatAge(age)}</span> : null}
        </div>
      </div>
    </div>
    <div className="token-price">
      <strong>{formatTokenPrice(token.priceUsd)}</strong>
      <div className="token-changes">
        {token.priceChange1h !== null ? <StatusBadge tone={toneOf(token.priceChange1h)}>1ó {formatSignedPercent(token.priceChange1h)}</StatusBadge> : null}
        {token.priceChange24h !== null ? <StatusBadge tone={toneOf(token.priceChange24h)}>24ó {formatSignedPercent(token.priceChange24h)}</StatusBadge> : null}
        {changeSinceDetection !== null && token.priceChange1h === null ? <StatusBadge tone={toneOf(changeSinceDetection)} title="Az észleléskori árhoz képest">észlelés óta {formatSignedPercent(changeSinceDetection, 1)}</StatusBadge> : null}
      </div>
    </div>
    <dl className="token-figures">
      <div><dt>Likviditás</dt><dd>{formatCompactUsd(token.liquidityUsd)}</dd></div>
      <div><dt>{launch && !token.id ? 'Launch forgalom' : '24ó forgalom'}</dt><dd>{formatCompactUsd(token.volume24h)}</dd></div>
      <div><dt>Piaci kap.</dt><dd>{formatCompactUsd(token.marketCap)}</dd></div>
      <div><dt>Frissítve</dt><dd><StatusBadge tone={updated.tone} dot>{updated.text}</StatusBadge></dd></div>
    </dl>
    {token.openPositionId ? <Link className="primary-button token-position-link" href={`/positions/${token.openPositionId}`}>Nyitott PAPER pozíció →</Link> : null}
  </header>;
}
