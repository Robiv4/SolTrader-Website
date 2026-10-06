import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

import { env } from './config.js';
import { prisma } from './database.js';
import { redactSensitiveFields } from './secret-redaction.js';

export type AuthRole = 'ADMIN' | 'USER';

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  role: AuthRole;
  name?: string | null;
}

export interface StoredSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

const inMemoryUsers = new Map<string, StoredUser>();
const inMemorySessions = new Map<string, StoredSession>();

export function getSessionTtlMs() {
  const runtimeValue = Number(process.env.SESSION_TTL_SECONDS);
  if (env.NODE_ENV !== 'production' && Number.isInteger(runtimeValue) && runtimeValue >= 1 && runtimeValue <= 86_400) {
    return runtimeValue * 1000;
  }
  return env.SESSION_TTL_SECONDS * 1000;
}

async function withDbTimeout<T>(operation: Promise<T>, timeoutMs = 800): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      globalThis.setTimeout(() => reject(new Error(`Database operation timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function signSessionToken(token: string) {
  const secret = env.SESSION_SECRET;
  const digest = crypto.createHmac('sha256', secret).update(token).digest('hex');
  return `${token}.${digest}`;
}

export function verifySignedSessionToken(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [token, digest] = parts;

  const expected = crypto.createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex');
  if (expected.length !== digest.length) {
    return null;
  }

  const same = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
  return same ? token : null;
}

export function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: getSessionTtlMs() / 1000,
  };
}

export function isDatabaseUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('database') ||
    message.includes('ECONNREFUSED') ||
    message.includes("Can't reach database server") ||
    message.includes('connection') ||
    message.includes('Database operation timed out') ||
    message.includes('Foreign key constraint violated')
  );
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function comparePasswords(password: string, hashValue: string) {
  return bcrypt.compare(password, hashValue);
}

let adminBootstrap: Promise<StoredUser> | undefined;

/**
 * Ensures the configured admin account exists. The result is cached for the process lifetime, so
 * the bcrypt work and DB write happen once instead of on every login.
 */
export function ensureInitialAdminUser(): Promise<StoredUser> {
  if (!adminBootstrap) {
    adminBootstrap = bootstrapInitialAdminUser().then((user) => {
      // The in-memory development fallback is not cached, so the DB account is used once it is reachable.
      if (user.id === 'memory-admin') adminBootstrap = undefined;
      return user;
    }, (error: unknown) => {
      adminBootstrap = undefined;
      throw error;
    });
  }
  return adminBootstrap;
}

async function bootstrapInitialAdminUser(): Promise<StoredUser> {
  const email = env.ADMIN_EMAIL;
  const password = env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  }

  try {
    const existing = await withDbTimeout(
      prisma.user.findUnique({
        where: { email },
      }),
    );

    if (existing?.passwordHash && existing.role === 'ADMIN' && await comparePasswords(password, existing.passwordHash)) {
      return {
        id: existing.id,
        email: existing.email,
        passwordHash: existing.passwordHash,
        role: 'ADMIN',
        name: existing.name,
      } satisfies StoredUser;
    }

    const passwordHash = await hashPassword(password);
    if (existing) {
        const updated = await withDbTimeout(prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          role: 'ADMIN',
          name: existing.name ?? 'System Administrator',
        },
        }));

      return {
        id: updated.id,
        email: updated.email,
        passwordHash: updated.passwordHash ?? passwordHash,
        role: (updated.role ?? 'ADMIN') as AuthRole,
        name: updated.name,
      } satisfies StoredUser;
    }

    const created = await withDbTimeout(prisma.user.create({
      data: {
        email,
        name: 'System Administrator',
        passwordHash,
        role: 'ADMIN',
      },
    }));

    return {
      id: created.id,
      email: created.email,
      passwordHash: created.passwordHash ?? passwordHash,
      role: (created.role ?? 'ADMIN') as AuthRole,
      name: created.name,
    } satisfies StoredUser;
  } catch (error) {
    if (!isDatabaseUnavailableError(error) || env.NODE_ENV === 'production') {
      throw error;
    }

    const user = {
      id: 'memory-admin',
      email,
      passwordHash: await hashPassword(password),
      role: 'ADMIN' as const,
      name: 'System Administrator',
    } satisfies StoredUser;

    inMemoryUsers.set(email, user);
    return user;
  }
}

export async function getUserByEmail(email: string): Promise<StoredUser | null> {
  const fallbackUser = inMemoryUsers.get(email);

  try {
    const dbUser = await withDbTimeout(
      prisma.user.findUnique({
        where: { email },
      }),
    );

    if (!dbUser || !dbUser.passwordHash) return null;

    return {
      id: dbUser.id,
      email: dbUser.email,
      passwordHash: dbUser.passwordHash,
      role: (dbUser.role ?? 'ADMIN') as AuthRole,
      name: dbUser.name,
    } satisfies StoredUser;
  } catch (error) {
    if (isDatabaseUnavailableError(error) && env.NODE_ENV !== 'production') {
      return fallbackUser ?? null;
    }
    throw error;
  }
}

export async function findSessionByToken(token: string): Promise<{ userId: string; expiresAt: number } | null> {
  const tokenHash = hashToken(token);

  try {
    const dbSession = await withDbTimeout(
      prisma.session.findUnique({
        where: { tokenHash },
        select: { userId: true, expiresAt: true },
      }),
    );

    if (!dbSession) return null;

    return dbSession.expiresAt.getTime() > Date.now() ? { userId: dbSession.userId, expiresAt: dbSession.expiresAt.getTime() } : null;
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      if (env.NODE_ENV !== 'production') {
        const currentFallbackSession = inMemorySessions.get(tokenHash);
        return currentFallbackSession && currentFallbackSession.expiresAt > Date.now()
          ? { userId: currentFallbackSession.userId, expiresAt: currentFallbackSession.expiresAt }
          : null;
      }
      return null;
    }
    throw error;
  }
}

export async function createSessionForUser(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + getSessionTtlMs();

  const record: StoredSession = {
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
  };

  try {
    await withDbTimeout(prisma.session.upsert({
      where: { tokenHash },
      update: {
        userId,
        expiresAt: new Date(expiresAt),
      },
      create: {
        id: record.id,
        userId,
        tokenHash,
        expiresAt: new Date(expiresAt),
      },
    }));
  } catch (error) {
    if (!isDatabaseUnavailableError(error) || env.NODE_ENV === 'production') {
      throw error;
    }
    inMemorySessions.set(tokenHash, record);
  }

  return {
    token,
    signedToken: signSessionToken(token),
    expiresAt,
  };
}

export async function deleteSessionForToken(token: string | undefined) {
  const verifiedToken = verifySignedSessionToken(token);
  if (!verifiedToken) {
    return;
  }

  const tokenHash = hashToken(verifiedToken);
  if (inMemorySessions.delete(tokenHash)) return;

  try {
    await withDbTimeout(prisma.session.delete({
      where: { tokenHash },
    }));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return;
    if (!isDatabaseUnavailableError(error)) {
      throw error;
    }
    throw error;
  }
}

export async function getUserById(userId: string): Promise<StoredUser | null> {
  const fallback = [...inMemoryUsers.values()].find((user) => user.id === userId) ?? null;

  try {
    const dbUser = await withDbTimeout(
      prisma.user.findUnique({
        where: { id: userId },
      }),
    );

    if (!dbUser || !dbUser.passwordHash) {
      return null;
    }

    return {
      id: dbUser.id,
      email: dbUser.email,
      passwordHash: dbUser.passwordHash,
      role: (dbUser.role ?? 'ADMIN') as AuthRole,
      name: dbUser.name,
    } satisfies StoredUser;
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return env.NODE_ENV !== 'production' ? fallback : null;
    }
    throw error;
  }
}

export interface AuditEventEntry {
  id: string;
  userId: string | null;
  action: string;
  details: unknown;
  createdAt: string;
}

let auditListener: ((entry: AuditEventEntry) => void) | undefined;

/** Registers a listener that is told about every persisted audit event (used for the live log stream). */
export function onAuditEvent(listener: (entry: AuditEventEntry) => void) {
  auditListener = listener;
}

export async function logAuditEvent(action: string, userId: string | null, details: Record<string, unknown> = {}) {
  try {
    const entry = await withDbTimeout(prisma.auditLog.create({
      data: {
        userId,
        action,
        details: redactSensitiveFields(details) as Prisma.InputJsonValue,
      },
    }));
    try {
      auditListener?.({ id: entry.id, userId: entry.userId, action: entry.action, details: entry.details, createdAt: entry.createdAt.toISOString() });
    } catch {
      // A failing live-stream listener must never fail the audited action.
    }
  } catch (error) {
    if (isDatabaseUnavailableError(error) && env.NODE_ENV !== 'production') {
      return;
    }
    throw error;
  }
}

