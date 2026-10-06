import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

export function base58Decode(value: string): Uint8Array | null {
  if (!value) return null;
  const bytes: number[] = [];
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += '1';
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) output += BASE58_ALPHABET[digits[index]];
  return output;
}

/** A Solana public key is a base58 string that decodes to exactly 32 bytes. */
export function decodeSolanaPublicKey(address: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  const bytes = base58Decode(address);
  return bytes && bytes.length === 32 ? bytes : null;
}

export function verifyEd25519Signature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') },
      format: 'jwk',
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Accepts a signature encoded as base64 or base58 (wallets and libraries use both). */
export function decodeSignature(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    const bytes = Buffer.from(trimmed, 'base64');
    if (bytes.length === 64) return new Uint8Array(bytes);
  }
  const base58 = base58Decode(trimmed);
  return base58 && base58.length === 64 ? base58 : null;
}

interface PendingChallenge {
  message: string;
  network: string;
  expiresAt: number;
}

/**
 * One-time wallet ownership challenges. Each nonce is bound to the user and the wallet address,
 * expires after `ttlMs`, and is deleted on first use (successful or not) so it cannot be replayed.
 */
export class WalletChallengeStore {
  private readonly pending = new Map<string, PendingChallenge>();

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  issue(userId: string, userEmail: string, publicAddress: string, network: string) {
    this.prune();
    const nonce = crypto.randomBytes(16).toString('hex');
    const issuedAt = new Date();
    const expiresAt = issuedAt.getTime() + this.ttlMs;
    const message = [
      'Soltrader wallet verification',
      '',
      'Sign this message to prove you own this wallet. It does not authorize any transaction or cost any fee.',
      '',
      `Account: ${userEmail}`,
      `Wallet: ${publicAddress}`,
      `Network: ${network}`,
      `Nonce: ${nonce}`,
      `Issued at: ${issuedAt.toISOString()}`,
    ].join('\n');
    this.pending.set(this.key(userId, publicAddress, nonce), { message, network, expiresAt });
    return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Returns the exact message (and network) that was issued, or null when unknown/expired. Always single-use. */
  consume(userId: string, publicAddress: string, nonce: string): { message: string; network: string } | null {
    const key = this.key(userId, publicAddress, nonce);
    const challenge = this.pending.get(key);
    this.pending.delete(key);
    if (!challenge || challenge.expiresAt < Date.now()) return null;
    return { message: challenge.message, network: challenge.network };
  }

  private key(userId: string, publicAddress: string, nonce: string) {
    return `${userId}:${publicAddress}:${nonce}`;
  }

  private prune() {
    const now = Date.now();
    for (const [key, challenge] of this.pending) {
      if (challenge.expiresAt < now) this.pending.delete(key);
    }
  }
}

const DEFAULT_RPC_BY_NETWORK: Record<string, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

/** RPC endpoint for a wallet's network; the configured RPC is used for mainnet. */
export function rpcUrlForNetwork(network: string, configuredMainnetRpc?: string) {
  if ((network === 'mainnet-beta' || network === 'solana') && configuredMainnetRpc) return configuredMainnetRpc;
  return DEFAULT_RPC_BY_NETWORK[network === 'solana' ? 'mainnet-beta' : network] ?? DEFAULT_RPC_BY_NETWORK['mainnet-beta'];
}

/** Native SOL balance of an address via JSON-RPC getBalance. */
export async function fetchSolBalance(rpcUrl: string, publicAddress: string, timeoutMs = 5000): Promise<number> {
  const response = await globalThis.fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [publicAddress, { commitment: 'confirmed' }] }),
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC getBalance failed with HTTP ${response.status}`);
  const body = await response.json() as { result?: { value?: number }; error?: { message?: string } };
  if (body.error || typeof body.result?.value !== 'number') throw new Error(body.error?.message ?? 'RPC getBalance returned no value');
  return body.result.value / 1_000_000_000;
}
