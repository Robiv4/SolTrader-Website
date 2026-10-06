'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // New IP: second step with the code e-mailed to the account.
  const [challenge, setChallenge] = useState<{ challengeId: string; emailHint: string; expiresAt: string } | null>(null);
  const [code, setCode] = useState('');

  async function post(path: string, payload: unknown) {
    const response = await globalThis.fetch(`${apiBase}${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error ?? 'Unable to sign in');
    return body;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const body = await post('/api/auth/login', { email, password });
      if (body?.data?.verificationRequired) {
        setChallenge({ challengeId: body.data.challengeId, emailHint: body.data.emailHint, expiresAt: body.data.expiresAt });
        setCode('');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setLoading(true);
    setError('');
    try {
      await post('/api/auth/login/verify', { challengeId: challenge.challengeId, code });
      router.push('/dashboard');
      router.refresh();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'Hibás kód');
    } finally {
      setLoading(false);
    }
  }

  return <main className="login-page">
    <section className="login-panel">
      <div className="brand login-brand"><span className="brand-mark">S</span><div><strong>Soltrader</strong><small>CONTROL ROOM</small></div></div>
      <p className="eyebrow">Privát munkaterület</p>
      <h1>Bejelentkezés</h1>
      <p className="annotation">A paper kereskedési irányítópult eléréséhez használd az API-fiókod adatait.</p>
      {challenge ? <form onSubmit={verify} className="login-form">
        <p className="annotation">Új IP-címről lépsz be. Elküldtünk egy 6 jegyű kódot ide: <strong>{challenge.emailHint}</strong> (10 percig érvényes).</p>
        <label>Megerősítő kód<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-button" type="submit" disabled={loading || code.length !== 6}>{loading ? 'Ellenőrzés...' : 'Belépés megerősítése'}</button>
        <button className="text-button" type="button" disabled={loading} onClick={() => { setChallenge(null); setError(''); setCode(''); }}>Vissza / új kód kérése</button>
      </form> : <form onSubmit={submit} className="login-form">
        <label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label>
        <label>Jelszó<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-button" type="submit" disabled={loading}>{loading ? 'Bejelentkezés...' : 'Bejelentkezés'}</button>
      </form>}
      <p className="login-note">A kereskedési módot a szerver vezérli. Az éles végrehajtás alapértelmezés szerint le van tiltva.</p>
    </section>
  </main>;
}