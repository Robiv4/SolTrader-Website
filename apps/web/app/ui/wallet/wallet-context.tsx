'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { apiRequest } from '../../components';

import { connectWallet, toBase64, walletErrorMessage, type NetworkId, type WalletOption, type WalletSession } from './wallet-standard';

export interface LinkedWallet {
  id: string | null;
  type: 'USER' | 'BOT_TRADING';
  publicAddress: string | null;
  network: string;
  label: string;
  provider: string | null;
  connected: boolean;
  lastBalance: number | null;
  lastBalanceAt: string | null;
}

export interface TokenHolding {
  mint: string;
  program: 'spl-token' | 'spl-token-2022';
  amountRaw: string;
  decimals: number;
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

interface OverviewResponse { data: { connected: boolean; wallet?: LinkedWallet; portfolio?: WalletPortfolio | null; error?: string; refreshThrottled?: boolean } }

export type FlowStep = 'idle' | 'connecting' | 'confirm-sign' | 'signing' | 'verifying' | 'done' | 'error';
export interface FlowState { step: FlowStep; message: string | null; challenge?: string; wallet?: string }

interface WalletContextValue {
  loading: boolean;
  connected: boolean;
  wallet: LinkedWallet | null;
  portfolio: WalletPortfolio | null;
  rpcError: boolean;
  refreshThrottled: boolean;
  refreshing: boolean;
  reload: (force?: boolean) => Promise<void>;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  flow: FlowState;
  connect: (option: WalletOption, network: NetworkId) => Promise<void>;
  confirmSignature: () => Promise<void>;
  cancelFlow: () => void;
  disconnect: () => Promise<void>;
  /** The browser wallet switched to another account than the verified one (null = no mismatch). */
  accountMismatch: string | null;
  reverify: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet must be used inside <WalletProvider>');
  return value;
}

/**
 * The single place that knows the user's linked wallet. A wallet only counts as connected after the server verified a
 * signed, single-use, domain-bound challenge; balances are always the on-chain values of that verified address.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<OverviewResponse['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [flow, setFlow] = useState<FlowState>({ step: 'idle', message: null });
  const [accountMismatch, setAccountMismatch] = useState<string | null>(null);
  const session = useRef<WalletSession | null>(null);
  const pending = useRef<{ nonce: string; message: string; network: NetworkId } | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  const reload = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const response = await apiRequest<OverviewResponse>(`/api/wallet/overview${force ? '?refresh=1' : ''}`);
      setOverview(response.data);
    } catch {
      // keep the last known state; the UI shows the error state of the request that failed
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // Balances refresh rarely by themselves (RPC quota); the user can always refresh on demand.
    const timer = globalThis.setInterval(() => {
      if (!globalThis.document.hidden) void reload();
    }, 5 * 60_000);
    return () => globalThis.clearInterval(timer);
  }, [reload]);

  const linked = overview?.connected ? overview.wallet ?? null : null;

  const watchAccount = useCallback((current: WalletSession) => {
    unsubscribe.current?.();
    unsubscribe.current = current.onAccountChange((address) => {
      const verified = linked?.publicAddress ?? current.address;
      setAccountMismatch(address && address !== verified ? address : null);
    });
  }, [linked?.publicAddress]);

  useEffect(() => () => unsubscribe.current?.(), []);

  const requestChallenge = useCallback(async (current: WalletSession, network: NetworkId) => {
    const challenge = await apiRequest<{ data: { nonce: string; message: string } }>('/api/settings/wallet/challenge', { method: 'POST', body: JSON.stringify({ publicAddress: current.address, network }) });
    pending.current = { nonce: challenge.data.nonce, message: challenge.data.message, network };
    setFlow({ step: 'confirm-sign', message: null, challenge: challenge.data.message, wallet: current.option.name });
  }, []);

  const connect = useCallback(async (option: WalletOption, network: NetworkId) => {
    setFlow({ step: 'connecting', message: `Csatlakozás: ${option.name} – hagyd jóvá a kérést a wallet ablakában.`, wallet: option.name });
    try {
      const current = await connectWallet(option);
      session.current = current;
      await requestChallenge(current, network);
    } catch (error) {
      setFlow({ step: 'error', message: walletErrorMessage(error), wallet: option.name });
    }
  }, [requestChallenge]);

  /** Explicit second step: only now does the wallet show the (non-transaction) verification message. */
  const confirmSignature = useCallback(async () => {
    const current = session.current;
    const challenge = pending.current;
    if (!current || !challenge) return;
    setFlow((state) => ({ ...state, step: 'signing', message: 'Írd alá az ellenőrző üzenetet a walletben. Ez nem tranzakció, és nem kerül díjba.' }));
    try {
      const signature = await current.signMessage(new globalThis.TextEncoder().encode(challenge.message));
      setFlow((state) => ({ ...state, step: 'verifying', message: 'Aláírás ellenőrzése a szerveren…' }));
      await apiRequest('/api/settings/wallet/connect', {
        method: 'POST',
        body: JSON.stringify({ type: 'USER', publicAddress: current.address, network: challenge.network, provider: current.option.provider, label: current.option.name, nonce: challenge.nonce, signature: toBase64(signature) }),
      });
      pending.current = null;
      setAccountMismatch(null);
      watchAccount(current);
      await reload(true);
      setFlow({ step: 'done', message: 'A tárca csatlakoztatva és ellenőrizve.', wallet: current.option.name });
    } catch (error) {
      pending.current = null;
      // Nothing is shown as connected unless the server verified the signature.
      setFlow({ step: 'error', message: walletErrorMessage(error), wallet: current.option.name });
    }
  }, [reload, watchAccount]);

  const cancelFlow = useCallback(() => {
    pending.current = null;
    setFlow({ step: 'idle', message: null });
  }, []);

  const disconnect = useCallback(async () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    await session.current?.disconnect().catch(() => undefined);
    session.current = null;
    await apiRequest('/api/settings/wallet/disconnect', { method: 'POST', body: JSON.stringify({ type: 'USER' }) });
    setAccountMismatch(null);
    await reload();
  }, [reload]);

  /** The wallet switched account: the new address must be proven with a new, explicit signature. */
  const reverify = useCallback(async () => {
    const current = session.current;
    if (!current || !accountMismatch) return;
    setModalOpen(true);
    setFlow({ step: 'connecting', message: 'Az új fiók csatlakoztatása…', wallet: current.option.name });
    try {
      const fresh = await connectWallet(current.option);
      session.current = fresh;
      await requestChallenge(fresh, (linked?.network as NetworkId) ?? 'mainnet-beta');
    } catch (error) {
      setFlow({ step: 'error', message: walletErrorMessage(error), wallet: current.option.name });
    }
  }, [accountMismatch, linked?.network, requestChallenge]);

  const value = useMemo<WalletContextValue>(() => ({
    loading, connected: Boolean(linked?.publicAddress), wallet: linked, portfolio: overview?.portfolio ?? null, rpcError: overview?.error === 'RPC_UNAVAILABLE',
    refreshThrottled: Boolean(overview?.refreshThrottled), refreshing, reload,
    modalOpen, openModal: () => { setFlow({ step: 'idle', message: null }); setModalOpen(true); }, closeModal: () => { setModalOpen(false); if (flow.step !== 'done') cancelFlow(); },
    flow, connect, confirmSignature, cancelFlow, disconnect, accountMismatch, reverify,
  }), [loading, linked, overview, refreshing, reload, modalOpen, flow, connect, confirmSignature, cancelFlow, disconnect, accountMismatch, reverify]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
