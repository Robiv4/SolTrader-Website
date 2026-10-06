'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiRequest, date, fmt, Panel, Status } from './components';

export type WalletSummary = {
  id: string | null;
  type: 'USER' | 'BOT_TRADING';
  publicAddress: string | null;
  network: string;
  label: string;
  provider: string | null;
  isActive: boolean;
  status: string;
  connected: boolean;
  configured: boolean;
  lastBalance: number | null;
  lastBalanceAt: string | null;
};

export type WalletResponse = {
  userWallet: WalletSummary;
  botTradingWallet: WalletSummary;
  wallets: WalletSummary[];
};

type WalletProviderName = 'PHANTOM' | 'SOLFLARE' | 'BACKPACK' | 'OTHER';
type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

/** The subset of the injected Solana wallet standard (Phantom, Solflare, Backpack) this page uses. */
interface InjectedSolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array } | Uint8Array>;
}

type WalletWindow = typeof globalThis & {
  phantom?: { solana?: InjectedSolanaProvider };
  solflare?: InjectedSolanaProvider;
  backpack?: InjectedSolanaProvider;
  solana?: InjectedSolanaProvider;
};

const PROVIDERS: Array<{ value: WalletProviderName; label: string; installUrl?: string }> = [
  { value: 'PHANTOM', label: 'Phantom', installUrl: 'https://phantom.com/download' },
  { value: 'SOLFLARE', label: 'Solflare', installUrl: 'https://solflare.com/download' },
  { value: 'BACKPACK', label: 'Backpack', installUrl: 'https://backpack.app/download' },
  { value: 'OTHER', label: 'Egyéb (böngészőbe injektált Solana wallet)' },
];

const NETWORKS: Array<{ value: SolanaNetwork; label: string }> = [
  { value: 'mainnet-beta', label: 'Mainnet' },
  { value: 'devnet', label: 'Devnet' },
  { value: 'testnet', label: 'Testnet' },
];

function findProvider(name: WalletProviderName): InjectedSolanaProvider | undefined {
  const scope = globalThis as WalletWindow;
  switch (name) {
    case 'PHANTOM':
      return scope.phantom?.solana ?? (scope.solana?.isPhantom ? scope.solana : undefined);
    case 'SOLFLARE':
      return scope.solflare;
    case 'BACKPACK':
      return scope.backpack;
    default:
      return scope.solana;
  }
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function walletErrorMessage(error: unknown) {
  const code = (error as { code?: number } | null)?.code;
  if (code === 4001) return 'A kérést elutasítottad a walletben.';
  if (code === -32002) return 'A walletben már van egy függő kérés. Nyisd meg a wallet ablakát.';
  return error instanceof Error ? error.message : 'A wallet művelet sikertelen.';
}

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 6)}…${address.slice(-6)}` : null;
}

function BalanceLine({ wallet }: { wallet: WalletSummary }) {
  if (!wallet.publicAddress) return null;
  return <small>
    Egyenleg: {wallet.lastBalance == null ? 'N/A' : `${fmt(wallet.lastBalance, 6)} SOL`} · {NETWORKS.find((network) => network.value === wallet.network)?.label ?? wallet.network}
    {wallet.lastBalanceAt ? ` · frissítve: ${date(wallet.lastBalanceAt)}` : ''}
  </small>;
}

/**
 * Wallet management for the Settings page.
 *
 * User wallet: connected through the browser wallet extension, then linked to the account only after
 * the wallet signs a one-time server challenge (proof of ownership). Only the public address is stored.
 * Bot trading wallet: an administrator registers its public address; its key never touches the browser.
 */
export function WalletSettingsPanel() {
  const [state, setState] = useState<WalletResponse | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'neutral' | 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [providerName, setProviderName] = useState<WalletProviderName>('PHANTOM');
  const [network, setNetwork] = useState<SolanaNetwork>('mainnet-beta');
  const [label, setLabel] = useState('Saját wallet');
  const [installed, setInstalled] = useState<Record<WalletProviderName, boolean>>({ PHANTOM: false, SOLFLARE: false, BACKPACK: false, OTHER: false });
  const [botAddress, setBotAddress] = useState('');
  const [botNetwork, setBotNetwork] = useState<SolanaNetwork>('mainnet-beta');

  const load = useCallback(async () => {
    try {
      const response = await apiRequest<{ data: WalletResponse }>('/api/settings/wallet');
      setState(response.data);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'A wallet adatok nem tölthetők be.', tone: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
    // Extensions inject their providers shortly after page load, so detection is repeated once.
    const detect = () => setInstalled({ PHANTOM: Boolean(findProvider('PHANTOM')), SOLFLARE: Boolean(findProvider('SOLFLARE')), BACKPACK: Boolean(findProvider('BACKPACK')), OTHER: Boolean(findProvider('OTHER')) });
    detect();
    const timer = globalThis.setTimeout(detect, 800);
    return () => globalThis.clearTimeout(timer);
  }, [load]);

  const connectUserWallet = async () => {
    const provider = findProvider(providerName);
    const option = PROVIDERS.find((item) => item.value === providerName);
    if (!provider) {
      setMessage({ text: `${option?.label ?? 'A wallet'} bővítmény nem található ebben a böngészőben.${option?.installUrl ? ` Telepítés: ${option.installUrl}` : ''}`, tone: 'error' });
      return;
    }
    setBusy('connect');
    try {
      setMessage({ text: 'Csatlakozás a wallethez… hagyd jóvá a kérést a wallet ablakában.', tone: 'neutral' });
      const connection = await provider.connect();
      const publicAddress = (connection && 'publicKey' in connection ? connection.publicKey : undefined)?.toString() ?? provider.publicKey?.toString();
      if (!publicAddress) throw new Error('A wallet nem adott vissza nyilvános címet.');

      const challenge = await apiRequest<{ data: { nonce: string; message: string } }>('/api/settings/wallet/challenge', {
        method: 'POST',
        body: JSON.stringify({ publicAddress, network }),
      });
      setMessage({ text: 'Írd alá az ellenőrző üzenetet a walletben. Ez nem tranzakció, és nem kerül díjba.', tone: 'neutral' });
      const signed = await provider.signMessage(new globalThis.TextEncoder().encode(challenge.data.message), 'utf8');
      const signature = signed instanceof Uint8Array ? signed : signed.signature;

      await apiRequest('/api/settings/wallet/connect', {
        method: 'POST',
        body: JSON.stringify({ type: 'USER', publicAddress, network, provider: providerName, label: label.trim() || 'Saját wallet', nonce: challenge.data.nonce, signature: toBase64(signature) }),
      });
      setMessage({ text: `Wallet csatolva és ellenőrizve: ${shortAddress(publicAddress)}`, tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: walletErrorMessage(error), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const disconnectUserWallet = async () => {
    setBusy('disconnect');
    try {
      const provider = findProvider((state?.userWallet.provider as WalletProviderName | null) ?? providerName);
      await provider?.disconnect?.().catch(() => undefined);
      await apiRequest('/api/settings/wallet/disconnect', { method: 'POST', body: JSON.stringify({ type: 'USER' }) });
      setMessage({ text: 'A wallet leválasztva.', tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: walletErrorMessage(error), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const refreshBalances = async () => {
    setBusy('refresh');
    try {
      const response = await apiRequest<{ data: Array<{ ok: boolean; type: string }> }>('/api/settings/wallet/refresh-balance', { method: 'POST', body: '{}' });
      const failed = response.data.filter((row) => !row.ok);
      setMessage(failed.length > 0
        ? { text: 'Az egyenleg lekérése az RPC-ről nem sikerült. Ellenőrizd a SOLANA_RPC_URL beállítást.', tone: 'error' }
        : { text: response.data.length ? 'Egyenlegek frissítve.' : 'Nincs aktív wallet.', tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: walletErrorMessage(error), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const saveBotWallet = async () => {
    setBusy('bot');
    try {
      await apiRequest('/api/settings/wallet/connect', {
        method: 'POST',
        body: JSON.stringify({ type: 'BOT_TRADING', publicAddress: botAddress.trim(), network: botNetwork, provider: 'OTHER', label: 'Bot trading wallet' }),
      });
      setBotAddress('');
      setMessage({ text: 'A bot kereskedési wallet címe mentve.', tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: walletErrorMessage(error), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const removeBotWallet = async () => {
    setBusy('bot');
    try {
      await apiRequest('/api/settings/wallet/disconnect', { method: 'POST', body: JSON.stringify({ type: 'BOT_TRADING' }) });
      setMessage({ text: 'A bot kereskedési wallet eltávolítva.', tone: 'success' });
      await load();
    } catch (error) {
      setMessage({ text: walletErrorMessage(error), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const userWallet = state?.userWallet;
  const botWallet = state?.botTradingWallet;

  return <Panel title="Wallet">
    {message && <p className={`wallet-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}

    <div className="wallet-list">
      <div className="wallet-item">
        <div>
          <strong>Felhasználói wallet</strong>
          <small title={userWallet?.publicAddress ?? undefined}>{userWallet?.connected ? userWallet.publicAddress : 'Nincs csatolva'}</small>
          {userWallet?.connected && <BalanceLine wallet={userWallet} />}
        </div>
        <div className="row-inline">
          <Status tone={userWallet?.connected ? 'positive' : 'neutral'}>{userWallet?.connected ? 'CSATOLVA' : 'NINCS CSATOLVA'}</Status>
          {userWallet?.connected && <button type="button" className="secondary-button" disabled={busy !== null} onClick={disconnectUserWallet}>{busy === 'disconnect' ? 'Leválasztás…' : 'Leválasztás'}</button>}
        </div>
      </div>

      {!userWallet?.connected && <div className="field-grid">
        <label>Wallet<select value={providerName} onChange={(event) => setProviderName(event.target.value as WalletProviderName)}>
          {PROVIDERS.map((option) => <option key={option.value} value={option.value}>{option.label}{installed[option.value] ? '' : ' (nem észlelt)'}</option>)}
        </select></label>
        <label>Hálózat<select value={network} onChange={(event) => setNetwork(event.target.value as SolanaNetwork)}>
          {NETWORKS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label>Címke<input type="text" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      </div>}
      {!userWallet?.connected && <button type="button" className="primary-button" disabled={busy !== null} onClick={connectUserWallet}>
        {busy === 'connect' ? 'Csatolás folyamatban…' : `Csatlakozás: ${PROVIDERS.find((option) => option.value === providerName)?.label}`}
      </button>}

      <div className="wallet-item">
        <div>
          <strong>Bot kereskedési wallet</strong>
          <small title={botWallet?.publicAddress ?? undefined}>{botWallet?.publicAddress ?? 'Nincs beállítva'}</small>
          {botWallet?.connected && <BalanceLine wallet={botWallet} />}
        </div>
        <div className="row-inline">
          <Status tone={botWallet?.connected ? 'positive' : botWallet?.configured ? 'warning' : 'neutral'}>{botWallet?.connected ? 'BEÁLLÍTVA' : 'NINCS BEÁLLÍTVA'}</Status>
          {botWallet?.connected && <button type="button" className="secondary-button" disabled={busy !== null} onClick={removeBotWallet}>Eltávolítás</button>}
        </div>
      </div>
      {!botWallet?.connected && <div className="field-grid">
        <label>Bot wallet nyilvános címe<input type="text" placeholder="Solana nyilvános cím" value={botAddress} onChange={(event) => setBotAddress(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <label>Hálózat<select value={botNetwork} onChange={(event) => setBotNetwork(event.target.value as SolanaNetwork)}>
          {NETWORKS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
      </div>}
      {!botWallet?.connected && <button type="button" className="secondary-button" disabled={busy !== null || botAddress.trim().length < 32} onClick={saveBotWallet}>Bot wallet mentése</button>}
    </div>

    <div className="row-inline">
      <button type="button" className="secondary-button" disabled={busy !== null} onClick={refreshBalances}>{busy === 'refresh' ? 'Frissítés…' : 'Egyenlegek frissítése'}</button>
    </div>
    <p className="annotation">
      A felhasználói walletet a böngésző bővítménye csatolja: a wallet aláír egy egyszeri ellenőrző üzenetet (nem tranzakció, díjmentes), és csak a nyilvános cím kerül tárolásra.
      A bot wallet privát kulcsa soha nem kerül a böngészőbe; azt a szerver titokkezelése adja (BOT_TRADING_WALLET_SECRET). Bot walletet csak adminisztrátor állíthat be.
    </p>
  </Panel>;
}
