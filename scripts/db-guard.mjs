#!/usr/bin/env node
/**
 * Guarded database tooling. Every DB-changing project script goes through here.
 *
 *   node scripts/db-guard.mjs check                      validate DATABASE_URL / SHADOW_DATABASE_URL
 *   node scripts/db-guard.mjs backup                     pg_dump -Fc of the active DB into the backup directory
 *   node scripts/db-guard.mjs verify-backup [file]       restore a dump into a NEW temporary DB, compare, drop it
 *   node scripts/db-guard.mjs create-migration <name>    additive migration from `migrate diff --from-url` (no shadow DB)
 *   node scripts/db-guard.mjs deploy                     backup, then `prisma migrate deploy`
 *   node scripts/db-guard.mjs prisma <args...>           run the prisma CLI, refusing reset / force-reset / shadow misuse
 *
 * Never prints credentials. Never restores over, resets or drops the active database.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPrismaArgs, databaseIdentity, describeDatabase, destructiveStatements, validateShadowDatabase, verificationDatabaseName } from './db-guard-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** Loads KEY=VALUE pairs from the root .env without overriding the real environment (values are never printed). */
function loadEnv() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function fail(message, problems = []) {
  console.error(`\n[db-guard] REFUSED: ${message}`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

/** libpq does not understand Prisma's `schema` query parameter. */
function libpqUrl(url, database) {
  const parsed = new URL(url);
  parsed.searchParams.delete('schema');
  if (database) parsed.pathname = `/${database}`;
  return parsed.toString();
}

function pgTool(name) {
  const exe = isWindows ? `${name}.exe` : name;
  const candidates = [process.env.PG_BIN && path.join(process.env.PG_BIN, exe), isWindows && `C:\\Program Files\\PostgreSQL\\18\\bin\\${exe}`, isWindows && `C:\\Program Files\\PostgreSQL\\17\\bin\\${exe}`].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: false, cwd: root, env: process.env });
  if (result.error) fail(`could not start ${path.basename(command)}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) fail(`${path.basename(command)} exited with ${result.status}`, options.capture ? [String(result.stderr).split('\n').filter((line) => !/postgres(ql)?:\/\//.test(line)).slice(-5).join('\n')] : []);
  return result;
}

function prismaBin() {
  return path.join(root, 'node_modules', '.bin', isWindows ? 'prisma.CMD' : 'prisma');
}

/** Runs the local prisma CLI (a .CMD shim on Windows needs a shell, so the command is one quoted string). */
function prismaCommand(args, options = {}) {
  const quote = (arg) => (/[\s&|<>^"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  return spawnSync([`"${prismaBin()}"`, ...args.map(quote)].join(' '), { cwd: root, env: process.env, shell: true, encoding: 'utf8', stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
}

function runPrisma(args) {
  const result = prismaCommand(args);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function requireActiveDatabase() {
  const identity = databaseIdentity(process.env.DATABASE_URL);
  if (!identity) fail('DATABASE_URL is missing or not a postgres URL.');
  return identity;
}

function backupDirectory() {
  return process.env.DB_BACKUP_DIR || path.join(homedir(), 'Documents', 'soltrader-backups');
}

function backup(label = 'manual') {
  const identity = requireActiveDatabase();
  const directory = backupDirectory();
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(directory, `${identity.database}-${stamp}-${label}.dump`);
  console.log(`[db-guard] pg_dump ${describeDatabase(process.env.DATABASE_URL)} -> ${file}`);
  run(pgTool('pg_dump'), ['--format=custom', '--no-owner', `--file=${file}`, `--dbname=${libpqUrl(process.env.DATABASE_URL)}`]);
  console.log(`[db-guard] backup written (${Math.round(statSync(file).size / 1024)} KiB)`);
  return file;
}

function psql(url, sql) {
  const result = run(pgTool('psql'), ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', `--dbname=${url}`, '-c', sql], { capture: true });
  return String(result.stdout).trim();
}

const COUNTED_TABLES = ['User', 'Position', 'Trade', 'PositionEvent', 'PositionPathMetric', 'LaunchDecision', 'LaunchSnapshot', 'TokenMetric', 'Signal', 'PaperAccount', 'PaperOrder', 'AuditLog', 'NewLaunchConfig', 'NewLaunchConfigVersion', '_prisma_migrations'];

function tableCounts(url) {
  const existing = new Set(psql(url, "select table_name from information_schema.tables where table_schema = 'public'").split(/\r?\n/).filter(Boolean));
  const counts = {};
  for (const table of COUNTED_TABLES) counts[table] = existing.has(table) ? Number(psql(url, `select count(*) from "${table}"`)) : null;
  return { counts, tables: [...existing].sort() };
}

/** Restores a dump into a brand-new temporary database (never the active one), compares it, then drops it. */
function verifyBackup(fileArgument) {
  const identity = requireActiveDatabase();
  const directory = backupDirectory();
  const file = fileArgument ? path.resolve(fileArgument) : readdirSync(directory).filter((name) => name.endsWith('.dump')).map((name) => path.join(directory, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!file || !existsSync(file)) fail('no backup file found.');
  const tempName = verificationDatabaseName(identity.database);
  if (tempName === identity.database || !tempName.includes('_restore_verify_')) fail('refusing to restore into a database that is not a fresh verification database.');
  const maintenanceUrl = libpqUrl(process.env.DATABASE_URL, 'postgres');
  const tempUrl = libpqUrl(process.env.DATABASE_URL, tempName);
  console.log(`[db-guard] verifying ${file}\n[db-guard] temporary database: ${tempName} (the active database ${identity.database} is only read)`);
  psql(maintenanceUrl, `CREATE DATABASE "${tempName}"`);
  try {
    run(pgTool('pg_restore'), ['--no-owner', '--exit-on-error', `--dbname=${tempUrl}`, file], { capture: true });
    const restored = tableCounts(tempUrl);
    const active = tableCounts(libpqUrl(process.env.DATABASE_URL));
    const problems = [];
    const missing = active.tables.filter((table) => !restored.tables.includes(table));
    if (missing.length) problems.push(`tables missing from the restore: ${missing.join(', ')}`);
    console.log('\n  table                         restored      active');
    for (const table of COUNTED_TABLES) {
      const r = restored.counts[table];
      const a = active.counts[table];
      console.log(`  ${table.padEnd(28)} ${String(r ?? '—').padStart(9)}  ${String(a ?? '—').padStart(10)}`);
      // The active DB keeps growing while the worker runs; a restore may never contain MORE rows than it.
      if (r !== null && a !== null && r > a) problems.push(`${table}: restore has more rows (${r}) than the active DB (${a})`);
      if (a !== null && a > 0 && r === null) problems.push(`${table}: missing in the restore`);
    }
    if (restored.counts._prisma_migrations !== active.counts._prisma_migrations) problems.push(`migration count differs (restore ${restored.counts._prisma_migrations}, active ${active.counts._prisma_migrations}) - the dump predates a migration`);
    if (problems.length) {
      console.error('\n[db-guard] VERIFICATION WARNINGS:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 2;
    } else {
      console.log('\n[db-guard] backup verified: restorable, every table present, row counts consistent.');
    }
  } finally {
    psql(maintenanceUrl, `DROP DATABASE IF EXISTS "${tempName}"`);
    console.log(`[db-guard] temporary database ${tempName} dropped.`);
  }
}

/** Additive migration generated against the LIVE database (no shadow database is ever used or reset). */
function createMigration(name) {
  if (!name || !/^[a-z0-9_]+$/i.test(name)) fail('usage: pnpm db:create-migration <name> (letters, digits, underscore).');
  requireActiveDatabase();
  const result = prismaCommand(['migrate', 'diff', '--from-url', process.env.DATABASE_URL, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { capture: true });
  if (result.status !== 0) fail('prisma migrate diff failed', [String(result.stderr).split('\n').filter((line) => !/postgres(ql)?:\/\//.test(line)).slice(-5).join('\n')]);
  const sql = String(result.stdout);
  if (!sql.trim() || /^-- This is an empty migration/m.test(sql)) {
    console.log('[db-guard] schema and database are already in sync - nothing to create.');
    return;
  }
  const destructive = destructiveStatements(sql);
  if (destructive.length && process.env.SOLTRADER_ALLOW_DESTRUCTIVE_MIGRATION !== 'I_UNDERSTAND_THIS_DELETES_DATA') {
    fail('the generated migration is not additive. Rewrite it as an additive change (new nullable / defaulted columns, new tables).', destructive.map((statement) => statement.split('\n')[0]));
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const directory = path.join(root, 'prisma', 'migrations', `${stamp}_${name}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'migration.sql'), sql);
  console.log(`[db-guard] created ${path.relative(root, directory)}/migration.sql - review it, then run: pnpm db:deploy`);
}

loadEnv();
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'check': {
    console.log(`[db-guard] DATABASE_URL        = ${describeDatabase(process.env.DATABASE_URL)}`);
    console.log(`[db-guard] SHADOW_DATABASE_URL = ${process.env.SHADOW_DATABASE_URL ? describeDatabase(process.env.SHADOW_DATABASE_URL) : '(not set)'}`);
    const problems = process.env.SHADOW_DATABASE_URL ? validateShadowDatabase(process.env.DATABASE_URL, process.env.SHADOW_DATABASE_URL) : [];
    if (problems.length) fail('unsafe shadow database configuration', problems);
    console.log(process.env.SHADOW_DATABASE_URL ? '[db-guard] OK: the shadow database is separate.' : '[db-guard] OK: no shadow database configured; shadow-based commands (migrate dev) are unavailable.');
    break;
  }
  case 'backup':
    backup(args[0] ?? 'manual');
    break;
  case 'verify-backup':
    verifyBackup(args[0]);
    break;
  case 'create-migration':
    createMigration(args[0]);
    break;
  case 'deploy':
    backup('before-deploy');
    runPrisma(['migrate', 'deploy']);
    break;
  case 'migrate-dev': {
    const problems = validateShadowDatabase(process.env.DATABASE_URL, process.env.SHADOW_DATABASE_URL);
    if (problems.length) fail('migrate dev needs a separate shadow database', problems);
    backup('before-migrate-dev');
    runPrisma(['migrate', 'dev', '--create-only', ...args]);
    break;
  }
  case 'prisma': {
    const problems = checkPrismaArgs(args, process.env);
    if (process.env.SHADOW_DATABASE_URL) problems.push(...validateShadowDatabase(process.env.DATABASE_URL, process.env.SHADOW_DATABASE_URL).map((problem) => `SHADOW_DATABASE_URL: ${problem}`));
    if (problems.length) fail(`prisma ${args.join(' ').replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`, problems);
    runPrisma(args);
    break;
  }
  default:
    console.log('usage: node scripts/db-guard.mjs <check|backup|verify-backup [file]|create-migration <name>|deploy|migrate-dev|prisma ...args>');
    process.exit(command ? 1 : 0);
}
