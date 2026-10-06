/**
 * Administrator user management: list, create (USER or ADMIN), rename, change role, reset password, sign out
 * everywhere, delete. Mounted behind requireAuth + requireAdmin.
 *
 * Guard rails (enforced server-side, not only in the UI):
 *  - an administrator cannot delete or demote their own account;
 *  - the last administrator can never be removed or demoted;
 *  - the bootstrap administrator from the server configuration (ADMIN_EMAIL) cannot be deleted or demoted;
 *  - deletion requires typing the account's e-mail address and removes that user's own data only;
 *  - password hashes, session tokens and other secrets are never returned.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { StepUpGate } from './email-verification.js';

export interface AdminUsersDeps {
  prisma: PrismaClient;
  hashPassword: (password: string) => Promise<string>;
  logAuditEvent: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>;
  /** ADMIN_EMAIL from the server configuration (bootstrap account). */
  bootstrapAdminEmail: string;
  logger: { error(payload: unknown, message?: string): void };
  /** E-mail code confirmation of the acting admin (create / role / password / delete). Default: none. */
  stepUp?: StepUpGate;
}

const passwordSchema = z.string().min(10, 'A jelszó legalább 10 karakter legyen').max(200);
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email('Érvénytelen e-mail cím'),
  name: z.string().trim().max(100).optional().nullable(),
  password: passwordSchema,
  role: z.enum(['USER', 'ADMIN']).default('USER'),
});
const updateSchema = z.object({
  name: z.string().trim().max(100).nullable().optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
}).refine((value) => value.name !== undefined || value.role !== undefined, 'Nincs módosítandó mező');
const passwordResetSchema = z.object({ password: passwordSchema });
const deleteSchema = z.object({ confirmEmail: z.string().trim().toLowerCase() });

const fail = (res: Response, status: number, message: string, details?: unknown) => res.status(status).json({ ok: false, error: message, details });

export function createAdminUsersRouter(deps: AdminUsersDeps) {
  const { prisma } = deps;
  const router = Router();
  const bootstrapEmail = deps.bootstrapAdminEmail.trim().toLowerCase();
  const stepUp: StepUpGate = deps.stepUp ?? (async () => true);

  const adminCount = () => prisma.user.count({ where: { role: 'ADMIN' } });
  const publicUser = (user: { id: string; email: string; name: string | null; role: string; createdAt: Date; updatedAt: Date }) => ({
    id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString(),
    isBootstrapAdmin: user.email.toLowerCase() === bootstrapEmail,
  });

  router.get('/', async (req: Request, res: Response) => {
    try {
      const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, email: true, name: true, role: true, createdAt: true, updatedAt: true, avatarUpdatedAt: true } });
      const ids = users.map((user) => user.id);
      const [openPositions, trades, accounts, bots, sessions] = await Promise.all([
        prisma.position.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'OPEN' }, _count: { _all: true } }),
        prisma.trade.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } }),
        prisma.paperAccount.findMany({ where: { userId: { in: ids } }, select: { userId: true, equity: true, initialBalance: true } }),
        prisma.botConfig.findMany({ where: { userId: { in: ids } }, select: { userId: true, status: true, tradingMode: true } }),
        prisma.session.groupBy({ by: ['userId'], where: { userId: { in: ids }, expiresAt: { gt: new Date() } }, _count: { _all: true }, _max: { createdAt: true } }),
      ]);
      const byUser = <T extends { userId: string }>(rows: T[]) => new Map(rows.map((row) => [row.userId, row]));
      const openMap = byUser(openPositions);
      const tradeMap = byUser(trades);
      const accountMap = byUser(accounts);
      const botMap = new Map<string, { status: string; tradingMode: string }>();
      for (const bot of bots) if (!botMap.has(bot.userId)) botMap.set(bot.userId, { status: String(bot.status), tradingMode: String(bot.tradingMode) });
      const sessionMap = byUser(sessions);
      return res.json({ ok: true, data: {
        currentUserId: req.user!.id,
        admins: users.filter((user) => user.role === 'ADMIN').length,
        users: users.map((user) => {
          const account = accountMap.get(user.id);
          const session = sessionMap.get(user.id);
          return {
            ...publicUser(user),
            avatarVersion: user.avatarUpdatedAt?.getTime() ?? null,
            isSelf: user.id === req.user!.id,
            openPositions: openMap.get(user.id)?._count._all ?? 0,
            trades: tradeMap.get(user.id)?._count._all ?? 0,
            equity: account ? Number(account.equity) : null,
            initialBalance: account ? Number(account.initialBalance) : null,
            bot: botMap.get(user.id) ?? null,
            activeSessions: session?._count._all ?? 0,
            lastLoginAt: session?._max.createdAt ? session._max.createdAt.toISOString() : null,
          };
        }),
      } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Admin user list failed');
      return fail(res, 500, 'A felhasználók nem tölthetők be');
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Érvénytelen adatok', parsed.error.issues);
    try {
      if (await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } })) return fail(res, 409, 'Ezzel az e-mail címmel már van fiók');
      if (!await stepUp(req, res, 'admin_user_create', { email: parsed.data.email, name: parsed.data.name || null, role: parsed.data.role, password: parsed.data.password })) return;
      const user = await prisma.user.create({
        data: { email: parsed.data.email, name: parsed.data.name || null, role: parsed.data.role, passwordHash: await deps.hashPassword(parsed.data.password) },
        select: { id: true, email: true, name: true, role: true, createdAt: true, updatedAt: true },
      });
      await deps.logAuditEvent('admin_user_created', req.user!.id, { targetUserId: user.id, email: user.email, role: user.role });
      return res.status(201).json({ ok: true, data: publicUser(user) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return fail(res, 409, 'Ezzel az e-mail címmel már van fiók');
      deps.logger.error({ err: error }, 'Admin user create failed');
      return fail(res, 500, 'A fiók nem hozható létre');
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Érvénytelen adatok');
    try {
      const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
      if (!target) return fail(res, 404, 'A felhasználó nem található');
      if (parsed.data.role === 'USER' && target.role === 'ADMIN') {
        if (target.id === req.user!.id) return fail(res, 400, 'A saját admin jogodat nem veheted el');
        if (target.email.toLowerCase() === bootstrapEmail) return fail(res, 400, 'A szerver-konfigurációs (ADMIN_EMAIL) admin jogai nem vehetők el');
        if (await adminCount() <= 1) return fail(res, 400, 'Az utolsó admin jogai nem vehetők el');
      }
      // Role changes (grant / revoke admin) need the acting admin's e-mail code; a rename does not.
      if (parsed.data.role && parsed.data.role !== target.role && !await stepUp(req, res, 'admin_role_change', { id: target.id, role: parsed.data.role })) return;
      const user = await prisma.user.update({
        where: { id: target.id },
        data: { ...(parsed.data.name !== undefined ? { name: parsed.data.name || null } : {}), ...(parsed.data.role ? { role: parsed.data.role } : {}) },
        select: { id: true, email: true, name: true, role: true, createdAt: true, updatedAt: true },
      });
      if (parsed.data.role && parsed.data.role !== target.role) {
        await deps.logAuditEvent(parsed.data.role === 'ADMIN' ? 'admin_role_granted' : 'admin_role_revoked', req.user!.id, { targetUserId: user.id, email: user.email });
      } else {
        await deps.logAuditEvent('admin_user_updated', req.user!.id, { targetUserId: user.id, email: user.email });
      }
      return res.json({ ok: true, data: publicUser(user) });
    } catch (error) {
      deps.logger.error({ err: error }, 'Admin user update failed');
      return fail(res, 500, 'A felhasználó nem módosítható');
    }
  });

  router.post('/:id/password', async (req: Request, res: Response) => {
    const parsed = passwordResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Érvénytelen jelszó');
    try {
      const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, email: true } });
      if (!target) return fail(res, 404, 'A felhasználó nem található');
      if (!await stepUp(req, res, 'admin_password_reset', { id: target.id, password: parsed.data.password })) return;
      await prisma.$transaction([
        prisma.user.update({ where: { id: target.id }, data: { passwordHash: await deps.hashPassword(parsed.data.password) } }),
        // A new password signs the account out everywhere (except the admin's own current session).
        prisma.session.deleteMany({ where: { userId: target.id, ...(target.id === req.user!.id ? { NOT: { tokenHash: req.sessionTokenHash ?? '' } } : {}) } }),
      ]);
      await deps.logAuditEvent('admin_password_reset', req.user!.id, { targetUserId: target.id, email: target.email });
      return res.json({ ok: true, data: { id: target.id } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Admin password reset failed');
      return fail(res, 500, 'A jelszó nem módosítható');
    }
  });

  router.post('/:id/sessions/revoke', async (req: Request, res: Response) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, email: true } });
      if (!target) return fail(res, 404, 'A felhasználó nem található');
      const result = await prisma.session.deleteMany({ where: { userId: target.id, ...(target.id === req.user!.id ? { NOT: { tokenHash: req.sessionTokenHash ?? '' } } : {}) } });
      await deps.logAuditEvent('admin_sessions_revoked', req.user!.id, { targetUserId: target.id, email: target.email, sessions: result.count });
      return res.json({ ok: true, data: { revoked: result.count } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Admin session revoke failed');
      return fail(res, 500, 'A munkamenetek nem zárhatók le');
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const parsed = deleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'A törléshez add meg a fiók e-mail címét');
    try {
      const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, email: true, role: true } });
      if (!target) return fail(res, 404, 'A felhasználó nem található');
      if (target.id === req.user!.id) return fail(res, 400, 'A saját fiókodat nem törölheted');
      if (target.email.toLowerCase() === bootstrapEmail) return fail(res, 400, 'A szerver-konfigurációs (ADMIN_EMAIL) admin fiók nem törölhető');
      if (target.role === 'ADMIN' && await adminCount() <= 1) return fail(res, 400, 'Az utolsó admin nem törölhető');
      if (parsed.data.confirmEmail !== target.email.toLowerCase()) return fail(res, 400, 'A megerősítő e-mail cím nem egyezik');
      if (!await stepUp(req, res, 'admin_user_delete', { id: target.id, confirmEmail: parsed.data.confirmEmail })) return;
      const userId = target.id;
      // Records whose relation to User is not cascading are removed first, children before parents.
      // Audit logs are kept for accountability, detached from the deleted account.
      const counts = await prisma.$transaction(async (tx) => {
        const trades = await tx.trade.findMany({ where: { userId }, select: { id: true } });
        const tradeIds = trades.map((trade) => trade.id);
        const transactions = tradeIds.length ? await tx.transaction.deleteMany({ where: { tradeId: { in: tradeIds } } }) : { count: 0 };
        const deletedTrades = await tx.trade.deleteMany({ where: { userId } });
        const positions = await tx.position.deleteMany({ where: { userId } });
        const signals = await tx.signal.deleteMany({ where: { userId } });
        const assessments = await tx.riskAssessment.deleteMany({ where: { userId } });
        const audit = await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });
        await tx.user.delete({ where: { id: userId } });
        return { transactions: transactions.count, trades: deletedTrades.count, positions: positions.count, signals: signals.count, riskAssessments: assessments.count, auditLogsDetached: audit.count };
      }, { timeout: 60_000 });
      await deps.logAuditEvent('admin_user_deleted', req.user!.id, { deletedUserId: userId, email: target.email, role: target.role, ...counts });
      return res.json({ ok: true, data: { id: userId, ...counts } });
    } catch (error) {
      deps.logger.error({ err: error }, 'Admin user delete failed');
      return fail(res, 500, 'A fiók nem törölhető');
    }
  });

  return router;
}
