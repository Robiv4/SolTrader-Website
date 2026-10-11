import { beforeAll, describe, expect, it, vi } from 'vitest';

type Account = { address: string; publicKey: Uint8Array; chains: string[]; features: string[] };
type ChangeListener = (properties: { accounts?: Account[] }) => void;

// Minimal browser surface for Wallet Standard discovery (node test environment).
const windowTarget = new globalThis.EventTarget();
Object.assign(globalThis, { window: windowTarget });

const wallet = await import('../app/ui/wallet/wallet-standard');
const primitives = await import('../app/ui/primitives');

function fakeStandardWallet(name: string, icon = 'data:image/svg+xml;base64,AAAA') {
  const account = (address: string): Account => ({ address, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] });
  const changeListeners = new Set<ChangeListener>();
  const signed: string[] = [];
  const instance = {
    name, icon, version: '1.0.0', chains: ['solana:mainnet', 'solana:devnet'], accounts: [] as Account[],
    features: {
      'standard:connect': { version: '1.0.0', connect: vi.fn(async () => ({ accounts: [account('Addr1111')] })) },
      'standard:disconnect': { version: '1.0.0', disconnect: vi.fn(async () => undefined) },
      'standard:events': { version: '1.0.0', on: (_event: 'change', listener: ChangeListener) => { changeListeners.add(listener); return () => changeListeners.delete(listener); } },
      'solana:signMessage': { version: '1.0.0', signMessage: vi.fn(async (input: { account: Account; message: Uint8Array }) => { signed.push(input.account.address); return [{ signedMessage: input.message, signature: new Uint8Array([1, 2, 3]) }]; }) },
    },
  };
  return { instance, signed, switchTo: (address: string | null) => { for (const listener of changeListeners) listener({ accounts: address ? [account(address)] : [] }); } };
}

describe('Wallet Standard discovery and session', () => {
  const phantom = fakeStandardWallet('Phantom');
  const other = fakeStandardWallet('Glow Wallet', 'https://evil.example/icon.svg');

  beforeAll(() => {
    wallet.listWallets(); // starts discovery (app-ready)
    for (const item of [phantom, other]) {
      windowTarget.dispatchEvent(new globalThis.CustomEvent('wallet-standard:register-wallet', { detail: (api: { register: (...wallets: unknown[]) => void }) => api.register(item.instance) }));
    }
  });

  it('lists the common wallets with install status and other detected Solana wallets', () => {
    const options = wallet.listWallets();
    const byName = Object.fromEntries(options.map((option) => [option.name, option]));
    expect(byName.Phantom).toMatchObject({ provider: 'PHANTOM', installed: true, source: 'standard' });
    expect(byName.Solflare).toMatchObject({ installed: false, source: 'none', installUrl: 'https://solflare.com/download' });
    expect(byName.Backpack.installed).toBe(false);
    expect(byName['Glow Wallet']).toMatchObject({ provider: 'OTHER', installed: true });
    // Only data: image icons are rendered (no remote fetch / script URL from a wallet).
    expect(byName['Glow Wallet'].icon).toBeNull();
    expect(byName.Phantom.icon).toMatch(/^data:image\/svg\+xml/);
  });

  it('connecting never signs; signing is a separate explicit call with the active account', async () => {
    const option = wallet.listWallets().find((item) => item.name === 'Phantom')!;
    const session = await wallet.connectWallet(option);
    expect(session.address).toBe('Addr1111');
    expect(phantom.instance.features['solana:signMessage'].signMessage).not.toHaveBeenCalled();

    const changes: Array<string | null> = [];
    const stop = session.onAccountChange((address) => changes.push(address));
    phantom.switchTo('Addr2222');
    phantom.switchTo(null);
    stop();
    phantom.switchTo('Addr3333');
    expect(changes).toEqual(['Addr2222', null]);

    const signature = await session.signMessage(new globalThis.TextEncoder().encode('challenge'));
    expect([...signature]).toEqual([1, 2, 3]);
    // Signs with the account the wallet switched to (the app then detects the mismatch and requires re-verification).
    expect(phantom.signed).toEqual(['Addr2222']);

    await session.disconnect();
    expect(phantom.instance.features['standard:disconnect'].disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports a missing wallet and user rejection in plain language', async () => {
    const solflare = wallet.listWallets().find((item) => item.name === 'Solflare')!;
    await expect(wallet.connectWallet(solflare)).rejects.toBeInstanceOf(wallet.WalletNotInstalledError);
    expect(wallet.walletErrorMessage(Object.assign(new Error('User rejected the request.'), { code: 4001 }))).toContain('elutasítottad');
    expect(wallet.walletErrorMessage({ code: -32002 })).toContain('függő kérés');
  });

  it('falls back to an injected legacy provider', async () => {
    const listeners = new Map<string, (key?: { toString(): string } | null) => void>();
    Object.assign(globalThis, { backpack: {
      connect: async () => ({ publicKey: { toString: () => 'BackpackAddr' } }),
      signMessage: async () => ({ signature: new Uint8Array([9]) }),
      disconnect: vi.fn(async () => undefined),
      on: (event: string, listener: (key?: { toString(): string } | null) => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
    } });
    const option = wallet.listWallets().find((item) => item.name === 'Backpack')!;
    expect(option).toMatchObject({ installed: true, source: 'injected' });
    const session = await wallet.connectWallet(option);
    expect(session.address).toBe('BackpackAddr');
    const changes: Array<string | null> = [];
    const stop = session.onAccountChange((address) => changes.push(address));
    listeners.get('accountChanged')?.({ toString: () => 'Other' });
    listeners.get('disconnect')?.();
    stop();
    expect(changes).toEqual(['Other', null]);
    expect(listeners.size).toBe(0);
  });

  it('builds network-aware explorer links', () => {
    expect(wallet.explorerUrl('Abc', 'mainnet-beta')).toBe('https://solscan.io/account/Abc');
    expect(wallet.explorerUrl('Abc', 'devnet')).toBe('https://solscan.io/account/Abc?cluster=devnet');
  });
});

describe('UI number formatting', () => {
  it('shows tiny token prices exactly with subscript zero counts', () => {
    expect(primitives.formatTokenPrice(0.0000041234)).toBe('$0.0₅4123');
    expect(primitives.formatTokenPrice(0.000000000123)).toBe('$0.0₉123');
    expect(primitives.formatTokenPrice(null)).toBe('—');
    expect(primitives.formatCompactUsd(25_400)).toBe('$25.4K');
    expect(primitives.formatCompactUsd(null)).toBe('—');
    expect(primitives.shortAddress('3Hf2M5kgtuyqNGFXo4fchqTaQSwvFYZZkt85vCbCpump', 5, 5)).toBe('3Hf2M…Cpump');
  });
});
