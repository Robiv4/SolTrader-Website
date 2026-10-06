'use client';
import { Bot, Copy, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { date, EmptyState, ErrorState, fmt, LoadingState, PageHeader, Panel, Status, useApi } from '../components';
import { StatList } from '../ui-cards';

type WalletSummary = {
	type: 'USER' | 'BOT_TRADING';
	publicAddress: string | null;
	network: string;
	label: string;
	provider: string | null;
	status: string;
	connected: boolean;
	configured: boolean;
	lastBalance: number | null;
	lastBalanceAt: string | null;
};

function WalletPanel({ title, wallet }: { title: string; wallet: WalletSummary }) {
	const [copied, setCopied] = useState(false);
	const address = wallet.publicAddress;
	const copyAddress = async () => {
		if (!address || !globalThis.navigator.clipboard) return;
		try {
			await globalThis.navigator.clipboard.writeText(address);
			setCopied(true);
			globalThis.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};
	const statusText = wallet.connected ? 'CSATLAKOZTATVA' : wallet.configured ? 'BEÁLLÍTVA' : 'NINCS BEÁLLÍTVA';
	return <Panel title={title} className="wallet-summary-panel" description={wallet.type === 'USER' ? 'A saját tárcád (azonosításhoz és befizetéshez)' : 'A bot kereskedő tárcája (csak LIVE módban használt)'}
		action={<Status tone={wallet.connected ? 'positive' : wallet.configured ? 'warning' : 'neutral'}>{statusText}</Status>}>
		<div className="wallet-summary-head"><span className="wallet-symbol" aria-hidden="true">{wallet.type === 'USER' ? <UserRound size={20} /> : <Bot size={20} />}</span><div><strong>{wallet.label}</strong><small>{wallet.type === 'USER' ? 'Felhasználói tárca' : 'Bot kereskedő tárca'}</small></div></div>
		<StatList items={[
			['Nyilvános cím', address ? <span className="wallet-address"><code title={address}>{address.slice(0, 6)}…{address.slice(-6)}</code><button className="copy-button" type="button" onClick={copyAddress} aria-label={`${title} címének másolása`} title="Nyilvános cím másolása"><Copy size={14} aria-hidden="true" />{copied ? 'Kimásolva' : 'Másolás'}</button></span> : <span className="wallet-unavailable">Nincs beállítva</span>],
			['Hálózat', wallet.network || '—'],
			['Szolgáltató', wallet.provider ?? '—'],
			['Egyenleg', wallet.lastBalance == null ? 'Nem elérhető' : `${fmt(wallet.lastBalance, 6)} SOL`],
			['Utolsó frissítés', wallet.lastBalanceAt ? date(wallet.lastBalanceAt) : '—'],
		]} />
		<p className="wallet-safety-note">Csak nyilvános tárcaadatok. Privát kulcs vagy visszaállító kifejezés itt soha nem jelenik meg.</p>
	</Panel>;
}

export default function WalletPage() {
	const { data, error, loading } = useApi<{ data: { userWallet: WalletSummary; botTradingWallet: WalletSummary } }>('/api/settings/wallet');
	if (loading && !data) return <><PageHeader eyebrow="Tőke" title="Tárca" /><LoadingState /></>;
	if (error && !data) return <><PageHeader eyebrow="Tőke" title="Tárca" /><ErrorState message={error} /></>;
	const wallets = data?.data;
	return <><PageHeader eyebrow="Tőke" title="Tárca" subtitle="A felhasználói és a bot kereskedő tárca állapota külön-külön" action={<Link className="secondary-button" href="/settings#security">Tárcák kezelése</Link>} />{wallets ? <section className="panel-grid wallet-grid"><WalletPanel title="Felhasználói tárca" wallet={wallets.userWallet} /><WalletPanel title="Bot kereskedő tárca" wallet={wallets.botTradingWallet} /></section> : <EmptyState message="A tárca adatai nem érhetők el." />}</>;
}
