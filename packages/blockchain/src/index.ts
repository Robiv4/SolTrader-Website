import { Connection, PublicKey, type Commitment } from '@solana/web3.js';

export type RpcProviderName = 'primary' | 'secondary' | 'fallback';

export interface RpcEndpoint {
  name: RpcProviderName;
  url: string;
}

export interface RpcConfig {
  network: string;
  commitment: Commitment;
  timeoutMs: number;
  rateLimitCooldownMs: number;
  endpoints: RpcEndpoint[];
}

export interface RpcEnvironment {
  SOLANA_NETWORK?: string;
  SOLANA_COMMITMENT?: string;
  SOLANA_RPC_URL?: string;
  SOLANA_PRIMARY_RPC_URL?: string;
  SOLANA_SECONDARY_RPC_URL?: string;
  SOLANA_FALLBACK_RPC_URL?: string;
  SOLANA_RPC_TIMEOUT_MS?: string;
  SOLANA_RPC_RATE_LIMIT_COOLDOWN_MS?: string;
}

const commitments = new Set<Commitment>(['processed', 'confirmed', 'finalized']);

function parsePositiveInteger(value: string | undefined, name: string, defaultValue: number) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function validateRpcUrl(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }

  return url.toString().replace(/\/$/, '');
}

export function loadRpcConfig(environment: RpcEnvironment = process.env): RpcConfig {
  const commitment = environment.SOLANA_COMMITMENT ?? 'confirmed';
  if (!commitments.has(commitment as Commitment)) {
    throw new Error('SOLANA_COMMITMENT must be processed, confirmed, or finalized');
  }

  // Only the primary endpoint is required. Secondary / fallback are optional failover endpoints: an empty value must
  // not disable the whole pool (that silently turned off all on-chain enrichment). A value that IS set must be valid.
  const optional = (value: string | undefined, name: string) => (value && value.trim() ? validateRpcUrl(value.trim(), name) : null);
  const primary = validateRpcUrl(environment.SOLANA_PRIMARY_RPC_URL?.trim() || environment.SOLANA_RPC_URL?.trim() || undefined, 'SOLANA_PRIMARY_RPC_URL');
  const secondary = optional(environment.SOLANA_SECONDARY_RPC_URL, 'SOLANA_SECONDARY_RPC_URL');
  const fallback = optional(environment.SOLANA_FALLBACK_RPC_URL, 'SOLANA_FALLBACK_RPC_URL');
  const endpoints: RpcEndpoint[] = [{ name: 'primary', url: primary }];
  for (const [name, url] of [['secondary', secondary], ['fallback', fallback]] as const) {
    // Duplicates add no failover value.
    if (url && !endpoints.some((endpoint) => endpoint.url === url)) endpoints.push({ name, url });
  }

  return {
    network: environment.SOLANA_NETWORK ?? 'mainnet-beta',
    commitment: commitment as Commitment,
    timeoutMs: parsePositiveInteger(environment.SOLANA_RPC_TIMEOUT_MS, 'SOLANA_RPC_TIMEOUT_MS', 5_000),
    rateLimitCooldownMs: parsePositiveInteger(
      environment.SOLANA_RPC_RATE_LIMIT_COOLDOWN_MS,
      'SOLANA_RPC_RATE_LIMIT_COOLDOWN_MS',
      30_000,
    ),
    endpoints,
  };
}

export interface TokenBalance {
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
}

export interface SolanaMintInfo {
  address: string;
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Owning token program as reported by the RPC ("spl-token" / "spl-token-2022"), when known. */
  tokenProgram?: string | null;
  /** Token-2022 extension names present on the mint (empty for legacy SPL mints). */
  extensions?: string[];
}

export interface TokenHolder {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
}

/** Percentage of circulating supply held by the given (largest) holder accounts, from real on-chain data. */
export function calculateHolderConcentrationPercent(holders: TokenHolder[], mintInfo: SolanaMintInfo): number {
  const totalSupplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;
  if (!Number.isFinite(totalSupplyUi) || totalSupplyUi <= 0) {
    return 100;
  }

  const topHoldersUi = holders.reduce((sum, holder) => sum + (holder.uiAmount ?? 0), 0);
  return Math.min(100, Math.round((topHoldersUi / totalSupplyUi) * 10000) / 100);
}

/** Percentage of circulating supply held by the single largest holder account. */
export function calculateTopHolderConcentrationPercent(holders: TokenHolder[], mintInfo: SolanaMintInfo): number {
  const totalSupplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;
  if (!Number.isFinite(totalSupplyUi) || totalSupplyUi <= 0) {
    return 100;
  }

  const largest = holders.reduce((max, holder) => Math.max(max, holder.uiAmount ?? 0), 0);
  return Math.min(100, Math.round((largest / totalSupplyUi) * 10000) / 100);
}

export interface SolanaConnection {
  getSlot(): Promise<number>;
  getBalance(address: string): Promise<number>;
  getTokenBalances(address: string): Promise<TokenBalance[]>;
  getMintInfo(address: string): Promise<SolanaMintInfo>;
  getTokenLargestHolders(mint: string, limit?: number): Promise<TokenHolder[]>;
}

export interface SolanaConnectionFactory {
  create(endpoint: RpcEndpoint, config: RpcConfig): SolanaConnection;
}

function createDefaultConnection(endpoint: RpcEndpoint, config: RpcConfig): SolanaConnection {
  // No built-in 429 retry loop (up to ~7.5 s per call): the pool fails over to the next endpoint and applies its own cooldown.
  const connection = new Connection(endpoint.url, { commitment: config.commitment, disableRetryOnRateLimit: true });

  return {
    async getSlot() {
      return connection.getSlot(config.commitment);
    },
    async getBalance(address) {
      return connection.getBalance(new PublicKey(address), config.commitment);
    },
    async getTokenBalances(address) {
      const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(address), { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }, config.commitment);
      return accounts.value.map(({ account }) => {
        const info = account.data.parsed.info;
        const tokenAmount = info.tokenAmount;
        return {
          mint: info.mint as string,
          amount: tokenAmount.amount as string,
          decimals: tokenAmount.decimals as number,
          uiAmount: tokenAmount.uiAmount as number | null,
        };
      });
    },
    async getMintInfo(address) {
      const info = await connection.getParsedAccountInfo(new PublicKey(address), config.commitment);
      const data = info.value?.data as { program?: string; parsed?: { info?: Record<string, unknown> } } | undefined;
      const parsed = data?.parsed?.info;
      if (!parsed) {
        throw new Error(`Mint account not found for ${address}`);
      }
      return {
        address,
        decimals: Number(parsed.decimals ?? 0),
        supply: String(parsed.supply ?? '0'),
        mintAuthority: (parsed.mintAuthority as string | null) ?? null,
        freezeAuthority: (parsed.freezeAuthority as string | null) ?? null,
        tokenProgram: data?.program ?? null,
        extensions: Array.isArray(parsed.extensions) ? (parsed.extensions as Array<{ extension?: unknown }>).map((entry) => String(entry.extension)) : [],
      };
    },
    async getTokenLargestHolders(mint, limit = 10) {
      const result = await connection.getTokenLargestAccounts(new PublicKey(mint), config.commitment);
      return result.value.slice(0, limit).map((entry) => ({
        address: entry.address.toBase58(),
        amount: entry.amount,
        decimals: entry.decimals,
        uiAmount: entry.uiAmount,
      }));
    },
  };
}

export const defaultConnectionFactory: SolanaConnectionFactory = {
  create: createDefaultConnection,
};

export class RpcTimeoutError extends Error {
  constructor(message = 'RPC request timed out') {
    super(message);
    this.name = 'RpcTimeoutError';
  }
}

export class RpcRateLimitError extends Error {
  constructor(message = 'RPC rate limit exceeded') {
    super(message);
    this.name = 'RpcRateLimitError';
  }
}

export class RpcUnavailableError extends Error {
  constructor(message = 'RPC provider unavailable') {
    super(message);
    this.name = 'RpcUnavailableError';
  }
}

export interface RpcHealth {
  provider: RpcProviderName;
  url: string;
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

/**
 * @deprecated Legacy pool (one web3.js Connection per endpoint, provider-wide cooldowns, no dedup / cache / priority).
 * The worker uses SolanaRpcManager (./rpc-manager.ts); kept for the read-only wallet helpers.
 */
export class RpcProviderPool {
  private activeProviderIndex = 0;
  private readonly unavailableUntil = new Map<RpcProviderName, number>();
  private readonly connections: SolanaConnection[];

  constructor(
    private readonly config: RpcConfig,
    private readonly factory: SolanaConnectionFactory = defaultConnectionFactory,
  ) {
    this.connections = config.endpoints.map((endpoint) => factory.create(endpoint, config));
  }

  get activeProvider(): RpcEndpoint {
    return this.config.endpoints[this.activeProviderIndex];
  }

  private isRateLimitError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
    return status === 429 || message.includes('429') || /rate.?limit/i.test(message);
  }

  private async withTimeout<T>(operation: Promise<T>) {
    return Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        globalThis.setTimeout(() => reject(new RpcTimeoutError()), this.config.timeoutMs);
      }),
    ]);
  }

  private async execute<T>(operation: (connection: SolanaConnection) => Promise<T>) {
    const errors: string[] = [];
    const providerCount = this.config.endpoints.length;

    for (let attempt = 0; attempt < providerCount; attempt += 1) {
      const index = (this.activeProviderIndex + attempt) % providerCount;
      const endpoint = this.config.endpoints[index];
      const unavailableUntil = this.unavailableUntil.get(endpoint.name) ?? 0;
      if (unavailableUntil > Date.now() && attempt < providerCount - 1) {
        continue;
      }

      try {
        const result = await this.withTimeout(operation(this.connections[index]));
        this.activeProviderIndex = index;
        return result;
      } catch (error) {
        const normalizedError = this.isRateLimitError(error)
          ? new RpcRateLimitError(error instanceof Error ? error.message : String(error))
          : error instanceof RpcTimeoutError
            ? error
            : new RpcUnavailableError(error instanceof Error ? error.message : String(error));
        errors.push(`${endpoint.name}: ${normalizedError.message}`);
        if (normalizedError instanceof RpcRateLimitError) {
          this.unavailableUntil.set(endpoint.name, Date.now() + this.config.rateLimitCooldownMs);
        } else if (/\b(401|403)\b|unauthori[sz]ed|forbidden|not allowed/i.test(normalizedError.message)) {
          // Credentials / plan without access: retrying soon is pointless, keep the endpoint out for 10 minutes.
          this.unavailableUntil.set(endpoint.name, Date.now() + 10 * 60_000);
        }
      }
    }

    throw new RpcUnavailableError(`All RPC providers failed: ${errors.join('; ')}`);
  }

  async getSlot() {
    return this.execute((connection) => connection.getSlot());
  }

  async getBalance(address: string) {
    return this.execute((connection) => connection.getBalance(address));
  }

  async getTokenBalances(address: string) {
    return this.execute((connection) => connection.getTokenBalances(address));
  }

  async getMintInfo(address: string) {
    return this.execute((connection) => connection.getMintInfo(address));
  }

  async getTokenLargestHolders(mint: string, limit = 10) {
    return this.execute((connection) => connection.getTokenLargestHolders(mint, limit));
  }

  async checkHealth(): Promise<RpcHealth[]> {
    return Promise.all(this.config.endpoints.map(async (endpoint, index) => {
      const startedAt = Date.now();
      try {
        await this.withTimeout(this.connections[index].getSlot());
        return {
          provider: endpoint.name,
          url: endpoint.url,
          ok: true,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          provider: endpoint.name,
          url: endpoint.url,
          ok: false,
          latencyMs: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  }
}

export type WalletType = 'USER_WALLET' | 'BOT_TRADING_WALLET';

export interface WalletBalances {
  walletType: WalletType;
  address: string;
  solBalanceLamports: number;
  tokenBalances: TokenBalance[];
}

export class ReadOnlyWallet {
  readonly address: string;

  constructor(
    readonly walletType: WalletType,
    address: string,
    private readonly rpc: RpcProviderPool,
  ) {
    try {
      this.address = new PublicKey(address).toBase58();
    } catch {
      throw new Error(`${walletType} address must be a valid Solana public key`);
    }
  }

  getAddress() {
    return this.address;
  }

  getSolBalance() {
    return this.rpc.getBalance(this.address);
  }

  getTokenBalances() {
    return this.rpc.getTokenBalances(this.address);
  }

  async getBalances(): Promise<WalletBalances> {
    const [solBalanceLamports, tokenBalances] = await Promise.all([this.getSolBalance(), this.getTokenBalances()]);
    return { walletType: this.walletType, address: this.address, solBalanceLamports, tokenBalances };
  }
}

export class UserWallet extends ReadOnlyWallet {
  constructor(address: string, rpc: RpcProviderPool) {
    super('USER_WALLET', address, rpc);
  }
}

export class BotTradingWallet extends ReadOnlyWallet {
  constructor(address: string, rpc: RpcProviderPool) {
    super('BOT_TRADING_WALLET', address, rpc);
  }
}

export interface BlockchainHealth {
  ok: boolean;
  network: string;
  blockHeight: number;
  activeProvider: RpcProviderName;
  providers: RpcHealth[];
}

export async function getBlockchainHealth(rpc: RpcProviderPool, config: RpcConfig): Promise<BlockchainHealth> {
  const providers = await rpc.checkHealth();
  const active = providers.find((provider) => provider.provider === rpc.activeProvider.name);
  return {
    ok: providers.some((provider) => provider.ok),
    network: config.network,
    blockHeight: active?.ok ? await rpc.getSlot() : 0,
    activeProvider: rpc.activeProvider.name,
    providers,
  };
}
export * from './rpc-manager.js';
