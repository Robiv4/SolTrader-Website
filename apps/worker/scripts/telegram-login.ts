/**
 * One-time interactive Telegram login: creates the MTProto StringSession for TELEGRAM_SESSION.
 *
 *   pnpm --filter @soltrader/worker telegram:login
 *
 * Needs TELEGRAM_API_ID / TELEGRAM_API_HASH (https://my.telegram.org -> API development tools) in the environment or
 * the repository .env. The phone number, login code and 2FA password are typed into THIS terminal only and sent only
 * to Telegram. The resulting session string is printed once to this terminal (it is not written to any file or log):
 * copy it into .env as TELEGRAM_SESSION. It grants full access to the account - treat it like a password.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { TelegramClient, sessions } from 'telegram';

function fromDotEnv(name: string) {
  try {
    const file = readFileSync(path.resolve(import.meta.dirname, '../../../.env'), 'utf8');
    const line = file.split(/\r?\n/).find((row) => row.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

const apiId = Number(process.env.TELEGRAM_API_ID ?? fromDotEnv('TELEGRAM_API_ID'));
const apiHash = process.env.TELEGRAM_API_HASH ?? fromDotEnv('TELEGRAM_API_HASH');
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required (environment or .env).');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const client = new TelegramClient(new sessions.StringSession(''), apiId, apiHash, { connectionRetries: 3 });
client.setLogLevel('error' as Parameters<typeof client.setLogLevel>[0]);

try {
  await client.start({
    phoneNumber: async () => rl.question('Phone number (international format, e.g. +36...): '),
    phoneCode: async () => rl.question('Login code from Telegram: '),
    password: async () => rl.question('2FA password (empty if none): '),
    onError: (error) => console.error('Login error:', error.message),
  });
  const session = client.session.save() as unknown as string;
  console.log('\nLogin OK. Put this line into .env (keep it secret, never commit it):\n');
  console.log(`TELEGRAM_SESSION=${session}\n`);
} finally {
  rl.close();
  await client.destroy().catch(() => undefined);
}
