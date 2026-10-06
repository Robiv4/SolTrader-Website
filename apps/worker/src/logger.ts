import pino from 'pino';

import { env } from './config.js';

const transport =
  env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
        },
      }
    : undefined;

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defence in depth: provider keys, auth headers and wallet secrets never reach the log output.
    redact: {
      paths: [
        'apiKey', '*.apiKey', 'OPENAI_API_KEY', '*.OPENAI_API_KEY', 'authorization', '*.authorization', 'Authorization', '*.Authorization',
        'headers.authorization', '*.headers.authorization', 'headers.Authorization', '*.headers.Authorization',
        'privateKey', '*.privateKey', 'secret', '*.secret', 'seedPhrase', '*.seedPhrase', 'mnemonic', '*.mnemonic', 'password', '*.password',
      ],
      censor: '[REDACTED]',
    },
  },
  transport ? pino.transport(transport) : undefined,
);
