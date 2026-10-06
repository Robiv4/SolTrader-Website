import { app, telegramBot } from './app.js';
import { env } from './config.js';
import { logger } from './logger.js';

const port = env.PORT;

app.listen(port, env.HOST, () => {
  logger.info({ port, host: env.HOST, mode: env.TRADING_MODE }, 'API server started');
  void telegramBot.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    telegramBot.stop();
    process.exit(0);
  });
}
