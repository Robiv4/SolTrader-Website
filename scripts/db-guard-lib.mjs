/**
 * Pure safety checks for database tooling (no I/O). Used by scripts/db-guard.mjs and its tests.
 *
 * Background: on 2026-09-30 `prisma migrate diff` with the shadow database pointed at the development
 * database reset it. These checks make that class of mistake impossible through the project scripts.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Identity of a Postgres database: normalised host, port, database name and schema. Never includes credentials. */
export function databaseIdentity(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
  const host = LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) ? 'localhost' : parsed.hostname.toLowerCase();
  const port = parsed.port || '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';
  const schema = parsed.searchParams.get('schema') || 'public';
  return { host, port, database, schema, key: `${host}:${port}/${database}?schema=${schema}` };
}

/** Printable description of a database URL without user / password. */
export function describeDatabase(url) {
  const identity = databaseIdentity(url);
  return identity ? identity.key : '(invalid or missing URL)';
}

/** True when both URLs point at the same database (same server, database and schema). */
export function sameDatabase(a, b) {
  const left = databaseIdentity(a);
  const right = databaseIdentity(b);
  return Boolean(left && right && left.key === right.key);
}

/**
 * Validates SHADOW_DATABASE_URL against DATABASE_URL. Returns a list of problems (empty = OK).
 * The shadow database is reset by Prisma, so it must be a separate, dedicated database.
 */
export function validateShadowDatabase(databaseUrl, shadowUrl) {
  const problems = [];
  if (!databaseIdentity(databaseUrl)) problems.push('DATABASE_URL is missing or not a postgres URL.');
  if (!shadowUrl) {
    problems.push('SHADOW_DATABASE_URL is not set. Create a separate, empty database (e.g. soltrader_shadow) and point SHADOW_DATABASE_URL at it.');
    return problems;
  }
  const shadow = databaseIdentity(shadowUrl);
  if (!shadow) {
    problems.push('SHADOW_DATABASE_URL is not a valid postgres URL.');
    return problems;
  }
  if (sameDatabase(databaseUrl, shadowUrl)) problems.push('SHADOW_DATABASE_URL points at the ACTIVE database (DATABASE_URL). Prisma resets the shadow database - this would wipe all data.');
  const active = databaseIdentity(databaseUrl);
  if (active && shadow.host === active.host && shadow.port === active.port && shadow.database === active.database) {
    if (!problems.some((problem) => problem.includes('ACTIVE'))) problems.push('SHADOW_DATABASE_URL uses the same database as DATABASE_URL (only the schema differs). Use a separate database.');
  }
  if (!/shadow/i.test(shadow.database)) problems.push(`The shadow database name "${shadow.database}" does not contain "shadow". Use a dedicated name such as soltrader_shadow.`);
  return problems;
}

/**
 * Classifies a raw prisma CLI invocation. Destructive operations against the active database are refused;
 * a shadow URL passed on the command line must be a separate database.
 */
export function checkPrismaArgs(args, env) {
  const joined = args.join(' ');
  const problems = [];
  const has = (flag) => args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
  const value = (flag) => {
    const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (index < 0) return null;
    return args[index].includes('=') ? args[index].slice(flag.length + 1) : args[index + 1] ?? null;
  };
  if (/\bmigrate\s+reset\b/.test(joined)) problems.push('`prisma migrate reset` drops every table of the target database.');
  if (/\bdb\s+push\b/.test(joined) && has('--force-reset')) problems.push('`prisma db push --force-reset` drops every table of the target database.');
  if (/\bdb\s+push\b/.test(joined) && has('--accept-data-loss')) problems.push('`prisma db push --accept-data-loss` may drop columns / tables with data.');
  if (/\bmigrate\s+dev\b/.test(joined)) {
    problems.push('`prisma migrate dev` can offer to reset the database on drift. Use `pnpm db:create-migration <name>` (diff against the live DB, no shadow) and `pnpm db:deploy`.');
  }
  const shadowArg = value('--shadow-database-url');
  if (shadowArg !== null) {
    for (const problem of validateShadowDatabase(env.DATABASE_URL, shadowArg)) problems.push(`--shadow-database-url: ${problem}`);
  }
  for (const flag of ['--from-url', '--to-url']) {
    const target = value(flag);
    if (target !== null && /\bmigrate\s+diff\b/.test(joined) && shadowArg !== null && sameDatabase(target, shadowArg)) problems.push(`${flag} and --shadow-database-url are the same database.`);
  }
  return problems;
}

/** Statements in a generated migration that would remove data; such migrations need an explicit override. */
export function destructiveStatements(sql) {
  return sql.split(/;\s*\n/).map((statement) => statement.trim()).filter((statement) => /\b(DROP\s+(TABLE|COLUMN|SCHEMA|TYPE|INDEX)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE)\b/i.test(statement));
}

/** Name of the temporary restore-verification database; never equal to the active database. */
export function verificationDatabaseName(activeDatabase, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const name = `${activeDatabase}_restore_verify_${stamp}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (name === activeDatabase) throw new Error('verification database name equals the active database');
  return name;
}
