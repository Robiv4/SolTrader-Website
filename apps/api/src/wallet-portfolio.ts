/**
 * Read-only on-chain portfolio of a linked (ownership-verified) user wallet: native SOL + SPL Token / Token-2022 accounts.
 *
 * - Public data only (address -> balances). No transaction, no signature, no key material.
 * - Network-specific RPC: a devnet wallet is never priced or mixed with mainnet balances.
 * - USD values only from a reliable, fresh price; otherwise null ("Nem elérhető"). The total is only reported when every
 *   non-zero holding has a price. Nothing is estimated or invented.
 * - Cached per address + network and rate limited per user, so the free RPC quota is not burnt by UI refreshes.
 */

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface TokenHolding {
  mint: string;
  program: 'spl-token' | 'spl-token-2022';
  /** Raw integer amount as a string (exact; never a float). */
  amountRaw: string;
  decimals: number;
  /** Exact decimal string (amountRaw / 10^decimals). */
  amount: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  valueUsd: number | null;
  priceSource: string | null;
}

export interface WalletPortfolio {
  address: string;
  network: string;
  sol: { balance: number; lamports: string; priceUsd: number | null; valueUsd: number | null };
  tokens: TokenHolding[];
  totalUsd: number | null;
  pricedTokens: number;
  unpricedTokens: number;
  fetchedAt: string;
}

type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/** JSON-RPC client for one endpoint (timeout per call; errors never contain the URL). */
export function jsonRpc(url: string, timeoutMs = 6000): RpcCall {
  let id = 0;
  return async (method, params) => {
    const response = await globalThis.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? 'error'}`);
    return body.result;
  };
}

/** Exact decimal string of a raw token amount (BigInt, no float rounding). */
export function formatRawAmount(raw: string, decimals: number) {
  if (!/^\d+$/.test(raw)) return '0';
  const value = BigInt(raw);
  if (decimals <= 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

interface ParsedTokenAccount {
  account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } } };
}

/** Token accounts of the owner (jsonParsed) -> holdings per mint (several accounts of one mint are summed exactly). */
export function parseTokenAccounts(result: unknown, program: TokenHolding['program']): Array<Pick<TokenHolding, 'mint' | 'program' | 'amountRaw' | 'decimals' | 'amount'>> {
  const accounts = ((result as { value?: ParsedTokenAccount[] } | null)?.value ?? []);
  const byMint = new Map<string, { raw: bigint; decimals: number }>();
  for (const entry of accounts) {
    const info = entry.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals;
    if (!info?.mint || typeof amount !== 'string' || !/^\d+$/.test(amount) || typeof decimals !== 'number') continue;
    const current = byMint.get(info.mint);
    byMint.set(info.mint, { raw: (current?.raw ?? 0n) + BigInt(amount), decimals });
  }
  return [...byMint.entries()].filter(([, value]) => value.raw > 0n).map(([mint, value]) => ({
    mint, program, amountRaw: value.raw.toString(), decimals: value.decimals, amount: formatRawAmount(value.raw.toString(), value.decimals),
  }));
}

export interface PortfolioDeps {
  rpcFor: (network: string) => RpcCall;
  /** Fresh USD price of a mint from a reliable source, or null. Only called for mainnet. */
  priceOf: (mint: string) => Promise<{ priceUsd: number; source: string } | null>;
  /** Known token metadata (symbol / name) from the local token tables. */
  metadataOf: (mints: string[]) => Promise<Map<string, { symbol: string | null; name: string | null }>>;
  now?: () => number;
  cacheMs?: number;
  /** At most this many tokens are priced per load (rate / quota protection); the rest stay "not available". */
  maxPricedTokens?: number;
}

export class WalletPortfolioService {
  private readonly cache = new Map<string, { at: number; value: WalletPortfolio }>();
  private readonly lastForced = new Map<string, number>();

  constructor(private readonly deps: PortfolioDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** A forced refresh is allowed at most every `minIntervalMs` per user (cached data is returned otherwise). */
  canForce(userId: string, minIntervalMs = 15_000) {
    const last = this.lastForced.get(userId) ?? 0;
    if (this.now() - last < minIntervalMs) return false;
    this.lastForced.set(userId, this.now());
    return true;
  }

  async load(address: string, network: string, force = false): Promise<WalletPortfolio> {
    const key = `${network}:${address}`;
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < (this.deps.cacheMs ?? 30_000)) return cached.value;
    const rpc = this.deps.rpcFor(network);
    const owner = { encoding: 'jsonParsed', commitment: 'confirmed' };
    const [balance, classic, token2022] = await Promise.all([
      rpc('getBalance', [address, { commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM_ID }, owner]),
      // Token-2022 is optional: an RPC without it must not hide the classic SPL holdings.
      rpc('getTokenAccountsByOwner', [address, { programId: TOKEN_2022_PROGRAM_ID }, owner]).catch(() => ({ value: [] })),
    ]);
    const lamports = (balance as { value?: number } | null)?.value;
    if (typeof lamports !== 'number') throw new Error('RPC getBalance returned no value');
    const holdings = [...parseTokenAccounts(classic, 'spl-token'), ...parseTokenAccounts(token2022, 'spl-token-2022')];
    const mainnet = network === 'mainnet-beta';
    const metadata = await this.deps.metadataOf(holdings.map((holding) => holding.mint)).catch(() => new Map());
    const solPrice = mainnet ? await this.deps.priceOf(WSOL_MINT).catch(() => null) : null;
    const maxPriced = this.deps.maxPricedTokens ?? 25;
    const tokens: TokenHolding[] = [];
    for (const [index, holding] of holdings.entries()) {
      const price = mainnet && index < maxPriced ? await this.deps.priceOf(holding.mint).catch(() => null) : null;
      const amount = Number(holding.amount);
      const usable = price && Number.isFinite(price.priceUsd) && price.priceUsd > 0 ? price : null;
      tokens.push({
        ...holding, symbol: metadata.get(holding.mint)?.symbol ?? null, name: metadata.get(holding.mint)?.name ?? null,
        priceUsd: usable?.priceUsd ?? null, valueUsd: usable && Number.isFinite(amount) ? amount * usable.priceUsd : null, priceSource: usable?.source ?? null,
      });
    }
    tokens.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || a.mint.localeCompare(b.mint));
    const sol = lamports / 1_000_000_000;
    const solValue = solPrice && solPrice.priceUsd > 0 ? sol * solPrice.priceUsd : null;
    const priced = tokens.filter((token) => token.valueUsd !== null);
    const allPriced = solValue !== null && priced.length === tokens.length;
    const value: WalletPortfolio = {
      address, network,
      sol: { balance: sol, lamports: String(lamports), priceUsd: solPrice?.priceUsd ?? null, valueUsd: solValue },
      tokens,
      totalUsd: allPriced ? solValue + priced.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0) : null,
      pricedTokens: priced.length,
      unpricedTokens: tokens.length - priced.length,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    this.cache.set(key, { at: this.now(), value });
    return value;
  }
}
