import crypto from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;
type Logger = { info(bindings: object, message: string): void; warn(bindings: object, message: string): void; error(bindings: object, message: string): void };
type ApprovalAction = (userId: string, approvalId: string) => Promise<{ status: number; body: { ok: boolean; error?: string; data?: Record<string, unknown> } }>;

export interface TelegramBotDependencies {
  token?: string;
  prisma: PrismaClient;
  redis: () => Promise<RedisClient>;
  logger: Logger;
  approve: ApprovalAction;
  reject: ApprovalAction;
  audit: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>;
  dashboardUrl?: string;
}

interface TelegramUser { id: number; username?: string; first_name?: string }
interface TelegramMessage { message_id: number; chat: { id: number; type: string; username?: string; title?: string }; from?: TelegramUser; text?: string; caption?: string; date?: number }
interface TelegramCallbackQuery { id: string; from: TelegramUser; message?: TelegramMessage; data?: string }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }

const LINK_TTL_SECONDS = 600;
const APPROVAL_SCAN_INTERVAL_MS = 4000;

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPrice(value: number) {
  if (!(value > 0)) return 'n/a';
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toPrecision(6)}`;
}

/**
 * Telegram bot for per-user notifications:
 *  - account linking with a one-time deep link (t.me/<bot>?start=<code>), stored as the user's chat id;
 *  - SEMI_AUTO approval requests sent with Accept / Reject buttons, executed through the same code path
 *    as the dashboard, only when the button press comes from the linked chat.
 * Uses long polling (getUpdates), so exactly one API process may run the bot at a time.
 */
export class TelegramBotService {
  private running = false;
  private offset = 0;
  private username?: string;
  private approvalTimer?: ReturnType<typeof globalThis.setInterval>;
  private pollAbort?: globalThis.AbortController;

  constructor(private readonly deps: TelegramBotDependencies) {}

  get configured() {
    return Boolean(this.deps.token);
  }

  get botUsername() {
    return this.username;
  }

  async start() {
    if (!this.deps.token || this.running) return;
    try {
      const me = await this.call<{ username: string }>('getMe', {});
      this.username = me.username;
      // Long polling and a webhook are mutually exclusive for a bot.
      await this.call('deleteWebhook', { drop_pending_updates: false });
    } catch (error) {
      this.deps.logger.error({ err: error }, 'Telegram bot could not start (check TELEGRAM_BOT_TOKEN)');
      return;
    }
    this.running = true;
    this.deps.logger.info({ bot: this.username }, 'Telegram bot started');
    void this.pollLoop();
    this.approvalTimer = globalThis.setInterval(() => {
      void this.syncApprovalMessages().catch((error: unknown) => this.deps.logger.warn({ err: error }, 'Telegram approval sync failed'));
    }, APPROVAL_SCAN_INTERVAL_MS);
  }

  stop() {
    this.running = false;
    this.pollAbort?.abort();
    if (this.approvalTimer) globalThis.clearInterval(this.approvalTimer);
  }

  /** One-time link for the dashboard: opening it in Telegram and pressing Start links the chat to the user. */
  async createLink(userId: string) {
    if (!this.username) throw new Error('Telegram bot is not running');
    const code = crypto.randomBytes(12).toString('hex');
    await (await this.deps.redis()).set(`telegram:link:${code}`, userId, { EX: LINK_TTL_SECONDS });
    return { url: `https://t.me/${this.username}?start=${code}`, expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString() };
  }

  async sendTestMessage(chatId: string) {
    await this.send(chatId, '✅ <b>Soltrader</b>: a Telegram értesítések működnek.');
  }

  async notifyUnlinked(chatId: string) {
    await this.send(chatId, 'A Soltrader fiókod leválasztva erről a Telegram-fiókról. Több értesítést nem küldök.').catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------

  private async call<T = unknown>(method: string, payload: Record<string, unknown>, signal?: globalThis.AbortSignal): Promise<T> {
    const response = await globalThis.fetch(`https://api.telegram.org/bot${this.deps.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal ?? globalThis.AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.error_code ?? response.status} ${body.description ?? ''}`.trim());
    return body.result as T;
  }

  private async send(chatId: string | number, text: string, replyMarkup?: Record<string, unknown>) {
    return this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  private async pollLoop() {
    let backoffMs = 1000;
    while (this.running) {
      try {
        this.pollAbort = new globalThis.AbortController();
        const timer = globalThis.setTimeout(() => this.pollAbort?.abort(), 40_000);
        const updates = await this.call<TelegramUpdate[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, this.pollAbort.signal)
          .finally(() => globalThis.clearTimeout(timer));
        backoffMs = 1000;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update).catch((error: unknown) => this.deps.logger.error({ err: error }, 'Telegram update handling failed'));
        }
      } catch (error) {
        if (!this.running) return;
        this.deps.logger.warn({ err: error }, 'Telegram polling failed; retrying');
        await new Promise((resolve) => globalThis.setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate) {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const message = update.message;
    // Group / channel messages where this bot was ADDED (authorized source) feed the Social Intelligence engine.
    if (message && message.chat.type !== 'private') return this.forwardGroupMessage(message);
    if (!message?.text || message.chat.type !== 'private') return;
    const [command, argument] = message.text.trim().split(/\s+/, 2);
    if (command === '/start' && argument) return this.linkChat(message, argument);
    if (command === '/stop') return this.unlinkChat(message);
    await this.send(message.chat.id, [
      '👋 <b>Soltrader bot</b>',
      '',
      'A fiókod csatolásához nyisd meg a Soltrader weboldalon a <b>Beállítások → Értesítések → Telegram csatolása</b> gombot.',
      'Csatolás után itt kapod meg a SEMI_AUTO jóváhagyási kéréseket.',
      '',
      'Leválasztás: /stop',
    ].join('\n'));
  }

  /**
   * Public / authorized group message -> Redis inbox for the worker's TelegramSocialProvider (short TTL). The author is
   * stored only as a one-way hash; nothing is read from chats the bot is not a member of.
   */
  private async forwardGroupMessage(message: TelegramMessage) {
    const text = message.text ?? message.caption;
    if (!text) return;
    const authorHash = message.from ? crypto.createHash('sha256').update(`tg:${message.from.id}`).digest('hex').slice(0, 16) : 'unknown';
    const payload = JSON.stringify({ chatId: String(message.chat.id), chatUsername: message.chat.username?.toLowerCase() ?? null, chatTitle: message.chat.title ?? null, messageId: message.message_id, authorId: authorHash, text: text.slice(0, 1_000), createdAt: (message.date ?? Math.floor(Date.now() / 1000)) * 1000, receivedAt: Date.now() });
    const redis = await this.deps.redis();
    await redis.lPush('social:telegram:inbox', payload);
    await redis.lTrim('social:telegram:inbox', 0, 4_999);
    await redis.expire('social:telegram:inbox', 3_600);
  }

  private async linkChat(message: TelegramMessage, code: string) {
    const redis = await this.deps.redis();
    const key = `telegram:link:${code}`;
    const userId = await redis.get(key);
    await redis.del(key);
    if (!userId) {
      await this.send(message.chat.id, '⚠️ Ez a csatolási link lejárt vagy már felhasználták. Kérj újat a Soltrader Beállítások oldalán.');
      return;
    }
    const chatId = String(message.chat.id);
    // One chat belongs to one account: detach it from any other user first.
    await this.deps.prisma.notificationConfig.updateMany({ where: { telegramChatId: chatId, NOT: { userId } }, data: { telegramChatId: null, telegramEnabled: false } });
    await this.deps.prisma.notificationConfig.upsert({
      where: { userId },
      update: { telegramChatId: chatId, telegramEnabled: true, updatedAt: new Date() },
      create: { userId, telegramChatId: chatId, telegramEnabled: true, emailAlerts: false, pushAlerts: false },
    });
    await this.deps.audit('telegram_linked', userId, { telegramUsername: message.from?.username ?? null });
    await this.send(message.chat.id, [
      '✅ <b>Soltrader fiók csatolva.</b>',
      '',
      'SEMI_AUTO módban itt kapod a vételi javaslatokat, és egy gombnyomással elfogadhatod vagy elutasíthatod őket.',
      'Leválasztás: /stop',
    ].join('\n'));
  }

  private async unlinkChat(message: TelegramMessage) {
    const chatId = String(message.chat.id);
    const configs = await this.deps.prisma.notificationConfig.findMany({ where: { telegramChatId: chatId }, select: { userId: true } });
    await this.deps.prisma.notificationConfig.updateMany({ where: { telegramChatId: chatId }, data: { telegramChatId: null, telegramEnabled: false } });
    for (const config of configs) await this.deps.audit('telegram_unlinked', config.userId, { source: 'telegram' });
    await this.send(message.chat.id, configs.length ? 'A Soltrader fiókod leválasztva. Több értesítést nem küldök.' : 'Ez a Telegram-fiók nincs Soltrader fiókhoz csatolva.');
  }

  private async handleCallback(query: TelegramCallbackQuery) {
    const [action, approvalId] = (query.data ?? '').split(':', 2);
    const chatId = String(query.message?.chat.id ?? query.from.id);
    const answer = (text: string) => this.call('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: false }).catch(() => undefined);
    if ((action !== 'a' && action !== 'r') || !approvalId) return answer('Ismeretlen művelet');

    // Authorization: the button must come from the chat linked to the approval's owner.
    const approval = await this.deps.prisma.approvalRequest.findUnique({ where: { id: approvalId }, include: { token: true, user: { include: { notificationConfigs: true } } } });
    const linkedChat = approval?.user.notificationConfigs[0]?.telegramChatId;
    if (!approval || !linkedChat || linkedChat !== chatId) {
      this.deps.logger.warn({ approvalId, chatId }, 'Telegram approval action from an unlinked chat was refused');
      return answer('Ehhez a kéréshez nincs jogosultságod.');
    }

    const result = action === 'a'
      ? await this.deps.approve(approval.userId, approval.id)
      : await this.deps.reject(approval.userId, approval.id);
    const outcome = result.body.ok
      ? action === 'a' ? `✅ <b>Elfogadva és végrehajtva</b> (${escapeHtml(approval.token.symbol)})` : '❌ <b>Elutasítva</b>'
      : `⚠️ <b>Nem hajtható végre:</b> ${escapeHtml(this.translateError(result.body.error ?? 'ismeretlen hiba'))}`;
    await answer(result.body.ok ? (action === 'a' ? 'Végrehajtva' : 'Elutasítva') : 'Nem hajtható végre');
    await this.finalizeMessage(approval.id, outcome);
  }

  private translateError(error: string) {
    if (error.includes('no longer pending')) return 'a kérés már nem függőben van';
    if (error.includes('expired')) return 'a kérés lejárt';
    if (error.includes('Insufficient paper balance')) return 'nincs elég paper egyenleg';
    if (error.includes('Position limit')) return 'elérted a pozíciólimitet';
    if (error.includes('SEMI_AUTO mode is not active')) return 'a fiók már nem SEMI_AUTO módban van';
    if (error.includes('Price moved up')) return `az ár túl sokat emelkedett a javaslat óta (${error.replace(/.*Price moved up /, '').replace(' since the proposal', '')})`;
    if (error.includes('Market data')) return 'nincs friss piaci ár';
    if (error.includes('Risk conditions changed')) return 'a token kockázati besorolása megváltozott';
    return error.replace(/^Approval rejected: /, '');
  }

  /** Sends new pending approvals and closes out messages whose approval was decided elsewhere or expired. */
  private async syncApprovalMessages() {
    const redis = await this.deps.redis();
    const now = new Date();
    const pending = await this.deps.prisma.approvalRequest.findMany({
      where: { status: 'PENDING', expiresAt: { gt: now }, user: { notificationConfigs: { some: { telegramEnabled: true, telegramChatId: { not: null } } } } },
      include: { token: true, user: { include: { notificationConfigs: true, riskConfigs: true } } },
      orderBy: { proposedAt: 'asc' },
      take: 20,
    });
    for (const approval of pending) {
      const chatId = approval.user.notificationConfigs[0]?.telegramChatId;
      if (!chatId) continue;
      const claimed = await redis.set(`telegram:approval:${approval.id}`, 'sending', { NX: true, EX: 3600 });
      if (claimed !== 'OK') continue;
      const entry = Number(approval.entryPrice);
      const notional = entry * Number(approval.positionSize);
      const minutesLeft = Math.max(1, Math.round((approval.expiresAt.getTime() - Date.now()) / 60_000));
      const text = [
        '🟡 <b>Jóváhagyásra váró vétel (SEMI_AUTO)</b>',
        '',
        `Token: <b>${escapeHtml(approval.token.symbol)}</b>`,
        `Összeg: <b>${notional.toFixed(2)} USDC</b> (paper)`,
        `Belépő ár: ${formatPrice(entry)}`,
        approval.stopLoss ? `Stop loss: ${formatPrice(Number(approval.stopLoss))}` : null,
        approval.takeProfit ? `Profitcél: ${formatPrice(Number(approval.takeProfit))}` : null,
        `Jelzés: ${Number(approval.signalScore).toFixed(0)}/100 · Kockázat: ${Number(approval.riskScore).toFixed(0)}/100`,
        '',
        `⏳ Lejár ${minutesLeft} percen belül.`,
        `<code>${escapeHtml(approval.token.address)}</code>`,
      ].filter((line): line is string => line !== null).join('\n');
      try {
        const sent = await this.send(chatId, text, { inline_keyboard: [[{ text: '✅ Elfogadom', callback_data: `a:${approval.id}` }, { text: '❌ Elutasítom', callback_data: `r:${approval.id}` }]] });
        await redis.set(`telegram:approval:${approval.id}`, JSON.stringify({ chatId, messageId: sent.message_id, text }), { EX: 86_400 });
        await redis.sAdd('telegram:open-approvals', approval.id);
      } catch (error) {
        await redis.del(`telegram:approval:${approval.id}`);
        this.deps.logger.warn({ err: error, approvalId: approval.id }, 'Telegram approval message failed');
      }
    }

    // Close out messages whose approval is no longer pending (decided on the web, expired, stale).
    const open = await redis.sMembers('telegram:open-approvals');
    if (open.length === 0) return;
    const states = await this.deps.prisma.approvalRequest.findMany({ where: { id: { in: open } }, select: { id: true, status: true, expiresAt: true, rejectionReason: true } });
    const byId = new Map(states.map((state) => [state.id, state]));
    for (const id of open) {
      const state = byId.get(id);
      if (state && state.status === 'PENDING' && state.expiresAt > now) continue;
      const label = !state ? 'ℹ️ A kérés már nem létezik.'
        : state.status === 'EXECUTED' || state.status === 'APPROVED' ? '✅ <b>Elfogadva</b> (a weboldalon)'
          : state.status === 'REJECTED' ? '❌ <b>Elutasítva</b> (a weboldalon)'
            : state.status === 'STALE' ? `⚠️ <b>Elavult:</b> ${escapeHtml(this.translateError(state.rejectionReason ?? ''))}`
              : '⌛ <b>Lejárt</b> – nem történt vétel.';
      await this.finalizeMessage(id, label);
    }
  }

  private async finalizeMessage(approvalId: string, outcome: string) {
    const redis = await this.deps.redis();
    await redis.sRem('telegram:open-approvals', approvalId);
    const raw = await redis.get(`telegram:approval:${approvalId}`);
    if (!raw || raw === 'sending') return;
    const stored = JSON.parse(raw) as { chatId: string; messageId: number; text: string; finalized?: boolean };
    if (stored.finalized) return;
    await redis.set(`telegram:approval:${approvalId}`, JSON.stringify({ ...stored, finalized: true }), { EX: 86_400 });
    await this.call('editMessageText', { chat_id: stored.chatId, message_id: stored.messageId, text: `${stored.text}\n\n${outcome}`, parse_mode: 'HTML', disable_web_page_preview: true })
      .catch((error: unknown) => this.deps.logger.warn({ err: error, approvalId }, 'Telegram message update failed'));
  }
}
