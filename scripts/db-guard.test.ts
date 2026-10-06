import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ESM helper without type declarations
import { checkPrismaArgs, databaseIdentity, destructiveStatements, sameDatabase, validateShadowDatabase, verificationDatabaseName } from './db-guard-lib.mjs';

const ACTIVE = 'postgresql://soltrader:secret@localhost:5432/soltrader?schema=public';

describe('db guard', () => {
  it('identifies databases without credentials and treats localhost aliases as the same server', () => {
    expect(databaseIdentity(ACTIVE).key).toBe('localhost:5432/soltrader?schema=public');
    expect(JSON.stringify(databaseIdentity(ACTIVE))).not.toContain('secret');
    expect(sameDatabase(ACTIVE, 'postgres://other:pw@127.0.0.1/soltrader')).toBe(true);
    expect(sameDatabase(ACTIVE, 'postgresql://soltrader:secret@localhost:5432/soltrader_shadow')).toBe(false);
  });

  it('requires a separate shadow database (the 2026-09-30 incident configuration is refused)', () => {
    expect(validateShadowDatabase(ACTIVE, undefined)[0]).toMatch(/not set/);
    expect(validateShadowDatabase(ACTIVE, 'postgresql://x:y@127.0.0.1:5432/soltrader?schema=public').join(' ')).toMatch(/ACTIVE database/);
    expect(validateShadowDatabase(ACTIVE, 'postgresql://x:y@localhost:5432/soltrader?schema=shadow').join(' ')).toMatch(/same database/);
    expect(validateShadowDatabase(ACTIVE, 'postgresql://x:y@localhost:5432/soltrader_shadow?schema=public')).toEqual([]);
  });

  it('refuses reset, force-reset, data-loss push, migrate dev and shadow misuse', () => {
    const env = { DATABASE_URL: ACTIVE };
    expect(checkPrismaArgs(['migrate', 'reset', '--force'], env)).not.toEqual([]);
    expect(checkPrismaArgs(['db', 'push', '--force-reset'], env)).not.toEqual([]);
    expect(checkPrismaArgs(['db', 'push', '--accept-data-loss'], env)).not.toEqual([]);
    expect(checkPrismaArgs(['migrate', 'dev', '--name', 'x'], env)).not.toEqual([]);
    expect(checkPrismaArgs(['migrate', 'diff', '--from-url', ACTIVE, '--to-schema-datamodel', 'prisma/schema.prisma', '--shadow-database-url', ACTIVE, '--script'], env).length).toBeGreaterThan(0);
    expect(checkPrismaArgs(['migrate', 'deploy'], env)).toEqual([]);
    expect(checkPrismaArgs(['migrate', 'diff', '--from-url', ACTIVE, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], env)).toEqual([]);
    expect(checkPrismaArgs(['generate'], env)).toEqual([]);
  });

  it('detects non-additive migration statements', () => {
    expect(destructiveStatements('ALTER TABLE "A" ADD COLUMN "b" INTEGER;\n')).toEqual([]);
    expect(destructiveStatements('ALTER TABLE "A" DROP COLUMN "b";\nDROP TABLE "C";\n')).toHaveLength(2);
  });

  it('restore verification never targets the active database', () => {
    const name = verificationDatabaseName('soltrader', new Date('2026-10-01T12:00:00Z'));
    expect(name).toBe('soltrader_restore_verify_20261001120000');
    expect(name).not.toBe('soltrader');
  });
});
