import { describe, expect, it } from 'vitest';

import { BOT_COMMAND_CHANNEL, BotCommandPublisher, BotCommandSubscriber } from '../src/index.js';

describe('BotCommandBus', () => {
  it('publishes typed commands on the bot command channel', async () => {
    const messages: Array<{ channel: string; message: string }> = [];
    const publisher = new BotCommandPublisher({
      publish: async (channel, message) => {
        messages.push({ channel, message });
        return 1;
      },
    });

    await publisher.updateStrategyConfig({ strategyName: 'momentum', isEnabled: true, configJson: { threshold: 70 } });

    expect(messages[0].channel).toBe(BOT_COMMAND_CHANNEL);
    expect(JSON.parse(messages[0].message)).toEqual({
      command: 'UPDATE_STRATEGY_CONFIG',
      payload: { strategyName: 'momentum', isEnabled: true, configJson: { threshold: 70 } },
    });
  });

  it('validates subscribed command messages', async () => {
    let received: string | undefined;
    const subscriber = new BotCommandSubscriber({
      subscribe: async (_channel, listener) => listener(JSON.stringify({ command: 'START', payload: {} }), BOT_COMMAND_CHANNEL),
      unsubscribe: async () => undefined,
    });

    await subscriber.subscribe((command) => { received = command.command; });
    expect(received).toBe('START');
  });
});