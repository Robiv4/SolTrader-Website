import { z } from 'zod';

export const BOT_COMMAND_CHANNEL = 'bot:commands' as const;

export const botCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('START'),
    payload: z.object({ requestedBy: z.string().min(1).optional() }),
  }),
  z.object({
    command: z.literal('STOP'),
    payload: z.object({ requestedBy: z.string().min(1).optional() }),
  }),
  z.object({
    command: z.literal('PAUSE'),
    payload: z.object({ requestedBy: z.string().min(1).optional() }),
  }),
  z.object({
    command: z.literal('EMERGENCY_STOP'),
    payload: z.object({ requestedBy: z.string().min(1).optional(), reason: z.string().min(1).max(500).optional() }),
  }),
  z.object({
    command: z.literal('UPDATE_STRATEGY_CONFIG'),
    payload: z.object({
      requestedBy: z.string().min(1).optional(),
      strategyName: z.string().min(1),
      isEnabled: z.boolean(),
      configJson: z.record(z.unknown()),
      maxExposure: z.number().nonnegative().optional(),
      maxPositions: z.number().int().nonnegative().optional(),
    }),
  }),
]);

export type BotCommand = z.infer<typeof botCommandSchema>;
export type BotCommandName = BotCommand['command'];
export type BotCommandPayload<TCommand extends BotCommandName> = Extract<BotCommand, { command: TCommand }>['payload'];

export interface RedisPublisherClient {
  publish(channel: string, message: string): Promise<number>;
}

export interface RedisSubscriberClient {
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

export class BotCommandPublisher {
  constructor(private readonly client: RedisPublisherClient, private readonly channel = BOT_COMMAND_CHANNEL) {}

  async publish(command: BotCommand): Promise<number> {
    const validated = botCommandSchema.parse(command);
    return this.client.publish(this.channel, JSON.stringify(validated));
  }

  async start(requestedBy?: string) {
    return this.publish({ command: 'START', payload: { requestedBy } });
  }

  async stop(requestedBy?: string) {
    return this.publish({ command: 'STOP', payload: { requestedBy } });
  }

  async pause(requestedBy?: string) {
    return this.publish({ command: 'PAUSE', payload: { requestedBy } });
  }

  async emergencyStop(reason?: string, requestedBy?: string) {
    return this.publish({ command: 'EMERGENCY_STOP', payload: { reason, requestedBy } });
  }

  async updateStrategyConfig(payload: BotCommandPayload<'UPDATE_STRATEGY_CONFIG'>) {
    return this.publish({ command: 'UPDATE_STRATEGY_CONFIG', payload });
  }
}

export class BotCommandSubscriber {
  private handler?: (command: BotCommand) => void | Promise<void>;

  constructor(private readonly client: RedisSubscriberClient, private readonly channel = BOT_COMMAND_CHANNEL) {}

  async subscribe(handler: (command: BotCommand) => void | Promise<void>) {
    this.handler = handler;
    await this.client.subscribe(this.channel, (message) => {
      const parsed = botCommandSchema.safeParse(JSON.parse(message));
      if (!parsed.success) {
        throw new Error(`Invalid bot command received: ${parsed.error.message}`);
      }
      void this.handler?.(parsed.data);
    });
  }

  async unsubscribe() {
    this.handler = undefined;
    await this.client.unsubscribe(this.channel);
  }
}
