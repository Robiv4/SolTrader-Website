/**
 * Solana wallet discovery and the two operations SolTrader needs: connect (public key) and signMessage (ownership
 * proof). Nothing else - no transaction signing, no sending, no key material.
 *
 * Discovery follows the Wallet Standard registration protocol (the events used by @wallet-standard/app), implemented
 * here without extra packages: wallets announce themselves with `wallet-standard:register-wallet`, and the app announces
 * itself with `wallet-standard:app-ready`. Older injected providers (window.phantom.solana, window.solflare,
 * window.backpack) are a fallback when a wallet does not implement the standard.
 */

export type NetworkId = 'mainnet-beta' | 'devnet' | 'testnet';

interface StandardAccount { address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[] }
interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  features: Readonly<Record<string, unknown>>;
  accounts: readonly StandardAccount[];
}
interface ConnectFeature { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }> }
interface DisconnectFeature { disconnect(): Promise<void> }
interface EventsFeature { on(event: 'change', listener: (properties: { accounts?: readonly StandardAccount[] }) => void): () => void }
interface SignMessageFeature { signMessage(...inputs: Array<{ account: StandardAccount; message: Uint8Array }>): Promise<ReadonlyArray<{ signedMessage: Uint8Array; signature: Uint8Array }>> }

interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array } | Uint8Array>;
  on?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: { toString(): string } | null) => void): void;
  off?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: { toString(): string } | null) => void): void;
  removeListener?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: { toString(): string } | null) => void): void;
}
type WalletScope = typeof globalThis & { phantom?: { solana?: InjectedProvider }; solflare?: InjectedProvider; backpack?: InjectedProvider; solana?: InjectedProvider };

export interface WalletOption {
  /** Stable id stored as the wallet provider (PHANTOM / SOLFLARE / BACKPACK / OTHER). */
  provider: 'PHANTOM' | 'SOLFLARE' | 'BACKPACK' | 'OTHER';
  name: string;
  /** Icon announced by the wallet itself (data: image URI only), or null. */
  icon: string | null;
  installed: boolean;
  installUrl: string | null;
  source: 'standard' | 'injected' | 'none';
  key: string;
}

export interface WalletSession {
  option: WalletOption;
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  disconnect(): Promise<void>;
  /** Calls back with the wallet's active address (null = disconnected) when the user switches account in the wallet. */
  onAccountChange(listener: (address: string | null) => void): () => void;
}

const KNOWN: Array<{ provider: WalletOption['provider']; name: string; installUrl: string; match: RegExp }> = [
  { provider: 'PHANTOM', name: 'Phantom', installUrl: 'https://phantom.com/download', match: /phantom/i },
  { provider: 'SOLFLARE', name: 'Solflare', installUrl: 'https://solflare.com/download', match: /solflare/i },
  { provider: 'BACKPACK', name: 'Backpack', installUrl: 'https://backpack.app/download', match: /backpack/i },
];

const registered = new Set<StandardWallet>();
const listeners = new Set<() => void>();
let started = false;

function isSolanaStandardWallet(wallet: StandardWallet) {
  return wallet.chains.some((chain) => chain.startsWith('solana:'))
    && typeof wallet.features['standard:connect'] === 'object'
    && typeof wallet.features['solana:signMessage'] === 'object';
}

function register(...wallets: StandardWallet[]) {
  for (const wallet of wallets) if (wallet && isSolanaStandardWallet(wallet)) registered.add(wallet);
  for (const listener of listeners) listener();
  return () => {
    for (const wallet of wallets) registered.delete(wallet);
    for (const listener of listeners) listener();
  };
}

/** Starts Wallet Standard discovery once per page (idempotent). */
function startDiscovery() {
  if (started || typeof globalThis.window === 'undefined') return;
  started = true;
  const api = Object.freeze({ register });
  globalThis.window.addEventListener('wallet-standard:register-wallet', ((event: globalThis.CustomEvent<(api: { register: typeof register }) => void>) => {
    try {
      event.detail(api);
    } catch {
      // a broken wallet registration never breaks the page
    }
  }) as globalThis.EventListener);
  try {
    globalThis.window.dispatchEvent(new globalThis.CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {
    // ignore
  }
}

/** Only image data URIs announced by the wallet are rendered (no remote fetches, no script URLs). */
function safeIcon(icon: string | undefined) {
  return icon && /^data:image\/(svg\+xml|png|webp|jpeg|gif);/.test(icon) ? icon : null;
}

function injected(provider: WalletOption['provider']): InjectedProvider | undefined {
  const scope = globalThis as WalletScope;
  if (provider === 'PHANTOM') return scope.phantom?.solana ?? (scope.solana?.isPhantom ? scope.solana : undefined);
  if (provider === 'SOLFLARE') return scope.solflare;
  if (provider === 'BACKPACK') return scope.backpack;
  return undefined;
}

/** Wallet list for the picker: the three common wallets always, plus any other detected standard Solana wallet. */
export function listWallets(): WalletOption[] {
  startDiscovery();
  const standard = [...registered];
  const options: WalletOption[] = KNOWN.map((known) => {
    const wallet = standard.find((item) => known.match.test(item.name));
    if (wallet) return { provider: known.provider, name: known.name, icon: safeIcon(wallet.icon), installed: true, installUrl: known.installUrl, source: 'standard', key: `standard:${wallet.name}` };
    const legacy = injected(known.provider);
    return { provider: known.provider, name: known.name, icon: null, installed: Boolean(legacy), installUrl: known.installUrl, source: legacy ? 'injected' : 'none', key: `known:${known.provider}` };
  });
  for (const wallet of standard) {
    if (KNOWN.some((known) => known.match.test(wallet.name))) continue;
    options.push({ provider: 'OTHER', name: wallet.name.slice(0, 40), icon: safeIcon(wallet.icon), installed: true, installUrl: null, source: 'standard', key: `standard:${wallet.name}` });
  }
  return options;
}

/** Re-renders the picker when wallets register late (extensions inject after page load). */
export function subscribeWallets(listener: () => void) {
  startDiscovery();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function standardWalletFor(option: WalletOption) {
  return [...registered].find((wallet) => `standard:${wallet.name}` === option.key) ?? null;
}

/** Connects the chosen wallet (the wallet shows its own approval prompt). Never signs anything by itself. */
export async function connectWallet(option: WalletOption): Promise<WalletSession> {
  const standard = option.source === 'standard' ? standardWalletFor(option) : null;
  if (standard) {
    const { accounts } = await (standard.features['standard:connect'] as ConnectFeature).connect();
    const account = accounts.find((item) => item.chains.some((chain) => chain.startsWith('solana:'))) ?? accounts[0];
    if (!account) throw new Error('A wallet nem adott vissza fiókot.');
    let current = account;
    return {
      option, address: account.address,
      async signMessage(message) {
        const [result] = await (standard.features['solana:signMessage'] as SignMessageFeature).signMessage({ account: current, message });
        if (!result?.signature) throw new Error('A wallet nem adott vissza aláírást.');
        return result.signature;
      },
      async disconnect() {
        await (standard.features['standard:disconnect'] as DisconnectFeature | undefined)?.disconnect().catch(() => undefined);
      },
      onAccountChange(listener) {
        const events = standard.features['standard:events'] as EventsFeature | undefined;
        if (!events) return () => undefined;
        return events.on('change', ({ accounts: next }) => {
          if (!next) return;
          current = next[0] ?? current;
          listener(next[0]?.address ?? null);
        });
      },
    };
  }
  const provider = injected(option.provider);
  if (!provider) throw new WalletNotInstalledError(option);
  const connection = await provider.connect();
  const address = (connection && 'publicKey' in connection ? connection.publicKey : undefined)?.toString() ?? provider.publicKey?.toString();
  if (!address) throw new Error('A wallet nem adott vissza nyilvános címet.');
  return {
    option, address,
    async signMessage(message) {
      const signed = await provider.signMessage(message, 'utf8');
      return signed instanceof Uint8Array ? signed : signed.signature;
    },
    async disconnect() {
      await provider.disconnect?.().catch(() => undefined);
    },
    onAccountChange(listener) {
      const onChange = (publicKey?: { toString(): string } | null) => listener(publicKey ? publicKey.toString() : null);
      const onDisconnect = () => listener(null);
      provider.on?.('accountChanged', onChange);
      provider.on?.('disconnect', onDisconnect);
      return () => {
        (provider.off ?? provider.removeListener)?.call(provider, 'accountChanged', onChange);
        (provider.off ?? provider.removeListener)?.call(provider, 'disconnect', onDisconnect);
      };
    },
  };
}

export class WalletNotInstalledError extends Error {
  constructor(readonly option: WalletOption) {
    super(`${option.name} nincs telepítve ebben a böngészőben.`);
  }
}

/** Human-readable wallet errors (user rejection, pending request, missing wallet). */
export function walletErrorMessage(error: unknown) {
  if (error instanceof WalletNotInstalledError) return error.message;
  const code = (error as { code?: number } | null)?.code;
  const text = error instanceof Error ? error.message : '';
  if (code === 4001 || /reject|denied|declined|cancel/i.test(text)) return 'A kérést elutasítottad a walletben. Semmi nem változott.';
  if (code === -32002) return 'A walletben már van egy függő kérés: nyisd meg a wallet ablakát.';
  return text || 'A wallet művelet sikertelen.';
}

export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

export const NETWORK_LABELS: Record<string, string> = { 'mainnet-beta': 'Mainnet', devnet: 'Devnet', testnet: 'Testnet' };

export function explorerUrl(address: string, network: string) {
  const cluster = network === 'devnet' ? '?cluster=devnet' : network === 'testnet' ? '?cluster=testnet' : '';
  return `https://solscan.io/account/${address}${cluster}`;
}
