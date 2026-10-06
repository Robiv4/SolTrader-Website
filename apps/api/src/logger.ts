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
    redact: {
      paths: [
        'password', '*.password', 'passwordHash', '*.passwordHash', 'passphrase', '*.passphrase',
        'secret', '*.secret', 'privateKey', '*.privateKey', 'private_key', '*.private_key',
        'seedPhrase', '*.seedPhrase', 'mnemonic', '*.mnemonic', 'apiKey', '*.apiKey',
        'accessToken', '*.accessToken', 'refreshToken', '*.refreshToken', 'authToken', '*.authToken', 'sessionToken', '*.sessionToken',
        'authorization', '*.authorization', 'cookie', '*.cookie',
        'err.message', 'err.stack', 'err.cause.message', 'err.cause.stack',
        'req.headers.cookie', 'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  },
  transport ? pino.transport(transport) : undefined,
);
