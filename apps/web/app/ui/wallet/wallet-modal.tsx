'use client';

import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useWallet } from './wallet-context';
import { listWallets, subscribeWallets, type NetworkId, type WalletOption } from './wallet-standard';

/** Wallet logo announced by the wallet itself, otherwise its initial. */
export function WalletIcon({ option, size = 32 }: { option: Pick<WalletOption, 'name' | 'icon'>; size?: number }) {
  return option.icon
    ? <img className="wallet-icon" src={option.icon} alt="" width={size} height={size} />
    : <span className="wallet-icon wallet-icon-fallback" style={{ width: size, height: size }} aria-hidden="true">{option.name.slice(0, 1)}</span>;
}

const STEPS: Array<{ id: string; label: string }> = [
  { id: 'connecting', label: 'Csatlakozás' },
  { id: 'confirm-sign', label: 'Üzenet aláírása' },
  { id: 'verifying', label: 'Ellenőrzés' },
];

/** Wallet picker + explicit ownership-verification steps. Read-only: no transaction is ever requested. */
export function WalletModal() {
  const { modalOpen, closeModal, flow, connect, confirmSignature, cancelFlow } = useWallet();
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [network, setNetwork] = useState<NetworkId>('mainnet-beta');
  const dialog = useRef<globalThis.HTMLDivElement>(null);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const refresh = () => setOptions(listWallets());
    refresh();
    const unsubscribe = subscribeWallets(refresh);
    // Extensions inject shortly after load: look once more.
    const timer = globalThis.setTimeout(refresh, 700);
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') closeModal(); };
    globalThis.document.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => {
      unsubscribe();
      globalThis.clearTimeout(timer);
      globalThis.document.removeEventListener('keydown', onKey);
    };
  }, [modalOpen, closeModal]);

  if (!modalOpen) return null;
  const busy = flow.step === 'connecting' || flow.step === 'signing' || flow.step === 'verifying';
  const stepIndex = flow.step === 'connecting' ? 0 : flow.step === 'confirm-sign' || flow.step === 'signing' ? 1 : flow.step === 'verifying' || flow.step === 'done' ? 2 : -1;

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) closeModal(); }}>
    <div className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title" tabIndex={-1} ref={dialog}>
      <header className="wallet-modal-head">
        <div><h2 id="wallet-modal-title">Tárca csatlakoztatása</h2><p>Csak olvasás: nyilvános cím és egyenlegek. Tranzakciót a SolTrader nem kér.</p></div>
        <button type="button" className="icon-btn" aria-label="Bezárás" onClick={closeModal} disabled={busy}><X size={18} /></button>
      </header>

      {flow.step === 'idle' || flow.step === 'error' ? <>
        {flow.step === 'error' ? <p className="notice notice-negative" role="alert">{flow.message}</p> : null}
        <ul className="wallet-options">
          {options.map((option) => <li key={option.key}>
            {option.installed
              ? <button type="button" className="wallet-option" onClick={() => void connect(option, network)}>
                <WalletIcon option={option} /><span className="wallet-option-name">{option.name}</span><span className="badge badge-positive">Észlelve</span>
              </button>
              : <a className="wallet-option muted" href={option.installUrl ?? '#'} target="_blank" rel="noreferrer noopener">
                <WalletIcon option={option} /><span className="wallet-option-name">{option.name}</span><span className="wallet-option-install">Telepítés <ExternalLink size={13} aria-hidden="true" /></span>
              </a>}
          </li>)}
        </ul>
        <label className="wallet-network">Hálózat
          <select value={network} onChange={(event) => setNetwork(event.target.value as NetworkId)}>
            <option value="mainnet-beta">Mainnet</option>
            <option value="devnet">Devnet</option>
          </select>
        </label>
      </> : <>
        <ol className="wallet-steps">
          {STEPS.map((step, index) => <li key={step.id} className={index < stepIndex ? 'done' : index === stepIndex ? 'current' : ''}>
            {index < stepIndex || flow.step === 'done' ? <CheckCircle2 size={16} aria-hidden="true" /> : index === stepIndex && busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <span className="step-dot" aria-hidden="true" />}
            {step.label}
          </li>)}
        </ol>
        {flow.message ? <p className={`notice ${flow.step === 'done' ? 'notice-positive' : 'notice-info'}`} role="status">{flow.message}</p> : null}
        {flow.step === 'confirm-sign' && flow.challenge ? <>
          <p className="wallet-sign-intro">A tulajdonjog igazolásához a {flow.wallet} ezt az üzenetet fogja aláíratni. Ez <strong>nem tranzakció</strong>, nem kerül díjba, és semmilyen jogosultságot nem ad.</p>
          <pre className="wallet-challenge" aria-label="Aláírandó üzenet">{flow.challenge}</pre>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={cancelFlow}>Mégse</button>
            <button type="button" className="primary-button" onClick={() => void confirmSignature()}>Aláírás a walletben</button>
          </div>
        </> : null}
        {flow.step === 'done' ? <div className="modal-actions"><button type="button" className="primary-button" onClick={closeModal}>Kész</button></div> : null}
      </>}

      <footer className="wallet-modal-foot"><ShieldCheck size={15} aria-hidden="true" /> Seed phrase-t vagy privát kulcsot soha nem kérünk. A csatlakoztatott tárca nem kap kereskedési jogosultságot, és nem kapcsol be LIVE kereskedést.</footer>
    </div>
  </div>;
}
