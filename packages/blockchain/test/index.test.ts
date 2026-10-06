import { describe, expect, it } from 'vitest';

import {
  BotTradingWallet,
  RpcProviderPool,
  UserWallet,
  loadRpcConfig,
  type RpcConfig,
  type RpcEndpoint,
  type SolanaConnection,
  type SolanaConnectionFactory,
} from '../src/index.js';

const walletAddress = '11111111111111111111111111111111';

function config(overrides: Partial<RpcConfig> = {}): RpcConfig {
  return {
    network: 'testnet',
    commitment: 'confirmed',
    timeoutMs: 25,
    rateLimitCooldownMs: 100,
    endpoints: [
      { name: 'primary', url: 'https://primary.example.test' },
      { name: 'secondary', url: 'https://secondary.example.test' },
      { name: 'fallback', url: 'https://fallback.example.test' },
    ],
    ...overrides,
  };
}

function factoryFor(connections: Record<string, Partial<SolanaConnection>>): SolanaConnectionFactory {
  return {
    create(endpoint: RpcEndpoint) {
      const connection = connections[endpoint.name];
      if (!connection) {
        throw new Error(`Missing fake connection for ${endpoint.name}`);
      }

      return {
        getSlot: connection.getSlot ?? (async () => 100),
        getBalance: connection.getBalance ?? (async () => 0),
        getTokenBalances: connection.getTokenBalances ?? (async () => []),
      };
    },
  };
}

describe('RPC configuration', () => {
  it('rejects missing and invalid provider configuration', () => {
    expect(() => loadRpcConfig({ SOLANA_RPC_URL: 'not-a-url' })).toThrow('SOLANA_PRIMARY_RPC_URL must be a valid URL');
    expect(() => loadRpcConfig({
      SOLANA_RPC_URL: 'https://primary.example.test',
      SOLANA_SECONDARY_RPC_URL: 'https://secondary.example.test',
      SOLANA_FALLBACK_RPC_URL: 'https://fallback.example.test',
      SOLANA_RPC_TIMEOUT_MS: '0',
    })).toThrow('SOLANA_RPC_TIMEOUT_MS must be a positive integer');
    expect(() => loadRpcConfig({})).toThrow('SOLANA_PRIMARY_RPC_URL is required');
    expect(() => loadRpcConfig({ SOLANA_RPC_URL: 'https://primary.example.test', SOLANA_FALLBACK_RPC_URL: 'nope' })).toThrow('SOLANA_FALLBACK_RPC_URL must be a valid URL');
  });

  it('an empty secondary / fallback does not disable the pool: the configured endpoints are used', () => {
    const onlyPrimary = loadRpcConfig({ SOLANA_RPC_URL: 'https://primary.example.test', SOLANA_SECONDARY_RPC_URL: '', SOLANA_FALLBACK_RPC_URL: '' });
    expect(onlyPrimary.endpoints).toEqual([{ name: 'primary', url: 'https://primary.example.test' }]);
    const two = loadRpcConfig({ SOLANA_PRIMARY_RPC_URL: 'https://primary.example.test', SOLANA_SECONDARY_RPC_URL: 'https://secondary.example.test', SOLANA_FALLBACK_RPC_URL: '' });
    expect(two.endpoints.map((endpoint) => endpoint.name)).toEqual(['primary', 'secondary']);
    const duplicate = loadRpcConfig({ SOLANA_PRIMARY_RPC_URL: 'https://primary.example.test', SOLANA_SECONDARY_RPC_URL: 'https://primary.example.test' });
    expect(duplicate.endpoints).toHaveLength(1);
  });
});

describe('RPC provider pool', () => {
  it('fails over after an RPC failure', async () => {
    const rpc = new RpcProviderPool(config(), factoryFor({
      primary: { getBalance: async () => { throw new Error('connection refused'); } },
      secondary: { getBalance: async () => 42 },
      fallback: { getBalance: async () => 84 },
    }));

    await expect(rpc.getBalance(walletAddress)).resolves.toBe(42);
    expect(rpc.activeProvider.name).toBe('secondary');
  });

  it('fails over after a timeout', async () => {
    const rpc = new RpcProviderPool(config({ timeoutMs: 5 }), factoryFor({
      primary: { getSlot: () => new Promise<number>(() => undefined) },
      secondary: { getSlot: async () => 7 },
      fallback: { getSlot: async () => 8 },
    }));

    await expect(rpc.getSlot()).resolves.toBe(7);
    expect(rpc.activeProvider.name).toBe('secondary');
  });

  it('reports health and latency for every provider', async () => {
    const rpc = new RpcProviderPool(config(), factoryFor({
      primary: { getSlot: async () => 1 },
      secondary: { getSlot: async () => { throw new Error('down'); } },
      fallback: { getSlot: async () => 3 },
    }));

    const health = await rpc.checkHealth();
    expect(health).toHaveLength(3);
    expect(health[0]).toMatchObject({ provider: 'primary', ok: true });
    expect(health[0].latencyMs).toEqual(expect.any(Number));
    expect(health[1]).toMatchObject({ provider: 'secondary', ok: false, latencyMs: null });
  });
});

describe('read-only wallets', () => {
  it('retrieves SOL and token balances without private key access', async () => {
    const rpc = new RpcProviderPool(config(), factoryFor({
      primary: {
        getBalance: async () => 1_500_000_000,
        getTokenBalances: async () => [{ mint: 'TokenMint', amount: '12', decimals: 6, uiAmount: 0.000012 }],
      },
      secondary: {},
      fallback: {},
    }));

    const userWallet = new UserWallet(walletAddress, rpc);
    const botWallet = new BotTradingWallet(walletAddress, rpc);
    const balances = await userWallet.getBalances();

    expect(balances).toEqual({
      walletType: 'USER_WALLET',
      address: walletAddress,
      solBalanceLamports: 1_500_000_000,
      tokenBalances: [{ mint: 'TokenMint', amount: '12', decimals: 6, uiAmount: 0.000012 }],
    });
    expect(botWallet.walletType).toBe('BOT_TRADING_WALLET');
    expect(() => new UserWallet('invalid-address', rpc)).toThrow('valid Solana public key');
  });
});