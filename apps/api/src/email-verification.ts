/**
 * E-mail verification codes (one-time, 6 digits):
 *  - LOGIN_NEW_IP: a login from an IP the account has not confirmed yet needs the code sent to the account's e-mail;
 *  - ADMIN_ACTION: sensitive admin actions (create user, grant / revoke admin, reset password, delete account, enable
 *    LIVE, clear emergency stop) need a code sent to the ACTING admin's e-mail ("is this really me?").
 *
 * Security properties:
 *  - codes and IPs are stored only as keyed HMACs (SESSION_SECRET); a code is bound to the user, the purpose and the
 *    exact action parameters (actionHash), so it cannot approve a different action or be used from another account;
 *  - 10 minute validity, max 5 attempts per code, single use, max 5 codes per user per 15 minutes;
 *  - fail closed: if the e-mail cannot be sent, the login / action does not proceed.
 *
 * Delivery: SMTP via nodemailer (SMTP_HOST ...). Without SMTP outside production, codes go to the API console
 * (development outbox) - never in production.
 */
import crypto from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import nodemailer from 'nodemailer';

export type VerificationPurpose = 'LOGIN_NEW_IP' | 'ADMIN_ACTION';

export const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CHALLENGES_PER_WINDOW = 5;
const CHALLENGE_WINDOW_MS = 15 * 60_000;

const ACTION_LABELS: Record<string, string> = {
  login: 'bejelentkezés új IP-címről',
  admin_user_create: 'új fiók létrehozása',
  admin_role_change: 'admin jog módosítása',
  admin_password_reset: 'jelszó módosítása más fiókban',
  admin_user_delete: 'fiók végleges törlése',
  live_enable: 'LIVE kereskedés engedélyezése',
  emergency_stop_clear: 'vészleállítás feloldása',
  ml_model_status: 'ML modell státuszának módosítása',
  ml_paper_approve: 'ML modell jóváhagyása PAPER kereskedésre',
  ml_paper_enable: 'ML PAPER stratégia bekapcsolása / modellváltás',
};

/** Enabled unless EMAIL_VERIFICATION_ENABLED=false (read per call; off by default only inside the test runner). */
export function verificationEnabled() {
  const value = process.env.EMAIL_VERIFICATION_ENABLED;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return !process.env.VITEST;
}

export class EmailDeliveryError extends Error {}

export interface OutgoingEmail { to: string; subject: string; text: string; code?: string; at: number }
/** Development / test outbox (only used when SMTP is not configured and NODE_ENV is not production). */
export const devOutbox: OutgoingEmail[] = [];

interface Logger { info(payload: unknown, message?: string): void; warn(payload: unknown, message?: string): void; error(payload: unknown, message?: string): void }

export function normalizeIp(ip: string | undefined | null) {
  const value = (ip ?? 'unknown').trim();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

/** Masked IP for display: 192.168.*.* / 2001:db8:*. Never the full address. */
export function ipHint(ip: string) {
  const value = normalizeIp(ip);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return value.split('.').slice(0, 2).join('.') + '.*.*';
  if (value.includes(':')) return value.split(':').filter(Boolean).slice(0, 2).join(':') + ':*';
  return '*';
}

export function emailHint(email: string) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export function createEmailVerification(deps: { prisma: PrismaClient; secret: string; logger: Logger; production: boolean }) {
  const { prisma } = deps;
  const hmac = (value: string) => crypto.createHmac('sha256', deps.secret).update(value).digest('hex');
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  const actionHashOf = (action: string, params: unknown) => hmac(`action:${action}:${stable(params)}`);
  const ipHashOf = (ip: string) => hmac(`ip:${normalizeIp(ip)}`);
  const codeHashOf = (challengeSalt: string, code: string) => hmac(`code:${challengeSalt}:${code}`);

  const smtpHost = process.env.SMTP_HOST?.trim();
  // The test runner never sends real e-mail, even when SMTP is configured: codes go to the in-memory outbox.
  const transport = smtpHost && !process.env.VITEST ? nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
  }) : null;
  const from = process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || 'SolTrader <no-reply@soltrader.local>';

  async function send(email: Omit<OutgoingEmail, 'at'>) {
    if (transport) {
      try {
        await transport.sendMail({ from, to: email.to, subject: email.subject, text: email.text });
        return;
      } catch (error) {
        deps.logger.error({ err: error instanceof Error ? error.message : String(error), to: emailHint(email.to) }, 'Verification e-mail delivery failed');
        throw new EmailDeliveryError('A megerősítő e-mail nem küldhető el');
      }
    }
    if (deps.production && !process.env.VITEST) throw new EmailDeliveryError('E-mail küldés nincs beállítva (SMTP_HOST)');
    devOutbox.push({ ...email, at: Date.now() });
    if (devOutbox.length > 100) devOutbox.shift();
    // Development only: no SMTP configured, so the code is shown in the API console.
    deps.logger.warn({ to: email.to, code: email.code, subject: email.subject }, 'DEV EMAIL OUTBOX (SMTP not configured): verification code');
  }

  async function createChallenge(input: { userId: string; email: string; purpose: VerificationPurpose; action: string; params: unknown; ip: string }) {
    const recent = await prisma.verificationChallenge.count({ where: { userId: input.userId, createdAt: { gte: new Date(Date.now() - CHALLENGE_WINDOW_MS) } } });
    if (recent >= MAX_CHALLENGES_PER_WINDOW) return { error: 'RATE_LIMITED' as const };
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const challenge = await prisma.verificationChallenge.create({
      data: {
        userId: input.userId, purpose: input.purpose, action: input.action, actionHash: actionHashOf(input.action, input.params),
        codeHash: `${salt}:${codeHashOf(salt, code)}`, ipHash: ipHashOf(input.ip), maxAttempts: MAX_ATTEMPTS, expiresAt,
      },
    });
    const label = ACTION_LABELS[input.action] ?? input.action;
    const when = new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' });
    try {
      await send({
        to: input.email, code,
        subject: `SolTrader megerősítő kód: ${code}`,
        text: [
          `Megerősítő kód: ${code}`,
          '',
          `Művelet: ${label}`,
          `IP-cím: ${ipHint(input.ip)}`,
          `Időpont: ${when}`,
          '',
          'A kód 10 percig érvényes és csak egyszer használható.',
          'Ha nem te kezdeményezted, NE add meg a kódot, és változtasd meg a jelszavadat.',
        ].join('\n'),
      });
    } catch (error) {
      await prisma.verificationChallenge.delete({ where: { id: challenge.id } }).catch(() => undefined);
      throw error;
    }
    return { challengeId: challenge.id, emailHint: emailHint(input.email), expiresAt: expiresAt.toISOString() };
  }

  type VerifyFailure = 'NOT_FOUND' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'INVALID_CODE' | 'ACTION_MISMATCH';
  async function verifyChallenge(input: { challengeId: string; userId?: string; purpose: VerificationPurpose; action: string; params: unknown; ip: string; code: string }): Promise<{ ok: true; userId: string } | { ok: false; reason: VerifyFailure; attemptsLeft?: number }> {
    const challenge = await prisma.verificationChallenge.findUnique({ where: { id: input.challengeId } });
    if (!challenge || challenge.purpose !== input.purpose || challenge.consumedAt || (input.userId && challenge.userId !== input.userId)) return { ok: false, reason: 'NOT_FOUND' };
    if (challenge.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED' };
    if (challenge.attempts >= challenge.maxAttempts) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
    // Count the attempt first (atomic, conditional): parallel guesses cannot exceed the limit.
    const counted = await prisma.verificationChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } }, data: { attempts: { increment: 1 } } });
    if (!counted.count) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
    const [salt, stored] = challenge.codeHash.split(':');
    const candidate = codeHashOf(salt, input.code.trim());
    const codeOk = stored.length === candidate.length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(candidate));
    const sameAction = challenge.action === input.action && challenge.actionHash === actionHashOf(input.action, input.params);
    const sameIp = !challenge.ipHash || challenge.ipHash === ipHashOf(input.ip);
    if (!codeOk) return { ok: false, reason: 'INVALID_CODE', attemptsLeft: Math.max(0, challenge.maxAttempts - challenge.attempts - 1) };
    if (!sameAction || !sameIp) return { ok: false, reason: 'ACTION_MISMATCH' };
    const consumed = await prisma.verificationChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (!consumed.count) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, userId: challenge.userId };
  }

  async function isTrustedIp(userId: string, ip: string) {
    const row = await prisma.trustedLoginIp.findUnique({ where: { userId_ipHash: { userId, ipHash: ipHashOf(ip) } } });
    if (row) await prisma.trustedLoginIp.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    return Boolean(row);
  }

  async function trustIp(userId: string, ip: string) {
    await prisma.trustedLoginIp.upsert({
      where: { userId_ipHash: { userId, ipHash: ipHashOf(ip) } },
      create: { userId, ipHash: ipHashOf(ip), ipHint: ipHint(ip) },
      update: { lastSeenAt: new Date() },
    });
  }

  return { createChallenge, verifyChallenge, isTrustedIp, trustIp, send };
}

export type EmailVerification = ReturnType<typeof createEmailVerification>;

export const VERIFY_FAILURE_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'A megerősítés nem található vagy már fel lett használva – kérj új kódot.',
  EXPIRED: 'A kód lejárt – kérj új kódot.',
  TOO_MANY_ATTEMPTS: 'Túl sok hibás próbálkozás – kérj új kódot.',
  INVALID_CODE: 'Hibás kód.',
  ACTION_MISMATCH: 'A kód nem ehhez a művelethez tartozik – kérj új kódot.',
};

/**
 * Step-up gate for a sensitive admin action, called AFTER validation and guard rails. Without `verification` in the
 * body: a code is e-mailed to the acting admin and 428 VERIFICATION_REQUIRED is answered (the client repeats the request
 * with { verification: { challengeId, code } }). Returns true when the action may proceed; otherwise the response was sent.
 */
export type StepUpGate = (req: Request, res: Response, action: string, params: unknown) => Promise<boolean>;

export function createStepUpGate(verification: EmailVerification): StepUpGate {
  return async (req, res, action, params) => {
    if (!verificationEnabled()) return true;
    const user = req.user;
    if (!user) {
      res.status(401).json({ ok: false, error: 'Authentication required' });
      return false;
    }
    const supplied = (req.body as { verification?: { challengeId?: unknown; code?: unknown } } | undefined)?.verification;
    try {
      if (supplied && typeof supplied.challengeId === 'string' && typeof supplied.code === 'string') {
        const result = await verification.verifyChallenge({ challengeId: supplied.challengeId, userId: user.id, purpose: 'ADMIN_ACTION', action, params, ip: req.ip ?? '', code: supplied.code });
        if (result.ok) return true;
        const retryable = result.reason === 'INVALID_CODE' && (result.attemptsLeft ?? 0) > 0;
        res.status(400).json({ ok: false, error: VERIFY_FAILURE_MESSAGES[result.reason], code: 'VERIFICATION_FAILED', data: { reason: result.reason, retryable, attemptsLeft: result.attemptsLeft ?? 0, challengeId: supplied.challengeId } });
        return false;
      }
      const challenge = await verification.createChallenge({ userId: user.id, email: user.email, purpose: 'ADMIN_ACTION', action, params, ip: req.ip ?? '' });
      if ('error' in challenge) {
        res.status(429).json({ ok: false, error: 'Túl sok megerősítő kód rövid időn belül – várj néhány percet.' });
        return false;
      }
      res.status(428).json({ ok: false, error: 'E-mailes megerősítés szükséges', code: 'VERIFICATION_REQUIRED', data: { verificationRequired: true, action, actionLabel: ACTION_LABELS[action] ?? action, ...challenge } });
      return false;
    } catch (error) {
      if (error instanceof EmailDeliveryError) {
        res.status(503).json({ ok: false, error: error.message });
        return false;
      }
      throw error;
    }
  };
}

/** Middleware form of the gate (for routes without their own guard rails before the action). */
export function requireEmailStepUp(gate: StepUpGate, action: string, paramsOf: (req: Request) => unknown) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (await gate(req, res, action, paramsOf(req))) next();
    } catch (error) {
      next(error);
    }
  };
}
