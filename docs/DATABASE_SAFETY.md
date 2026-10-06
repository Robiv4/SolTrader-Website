# Database safety

On 2026-09-30 `prisma migrate diff` was run with the shadow database pointing at the development database.
Prisma resets the shadow database, so the dev database was wiped. These rules and scripts make that impossible
through the project tooling.

## Rules

- Never reset, force-reset or `db push --accept-data-loss` the active database.
- Never use the active database (`DATABASE_URL`) as a shadow database.
- Schema changes are **additive** only: new tables, new nullable or defaulted columns.
- Take a backup before every migration. `pnpm db:deploy` does this automatically.
- Restore verification always uses a **new temporary database**, never the active one.

## Scripts

All of these go through `scripts/db-guard.mjs`. It never prints credentials.

| Command | What it does |
| --- | --- |
| `pnpm db:check` | Shows which databases `DATABASE_URL` and `SHADOW_DATABASE_URL` point at, and validates that they are separate. |
| `pnpm db:backup [label]` | Runs `pg_dump -Fc` of the active database into `~/Documents/soltrader-backups` (override with `DB_BACKUP_DIR`). |
| `pnpm db:verify-backup [file]` | Restores the newest dump (or the given file) into `<db>_restore_verify_<timestamp>`. Compares the table list and row counts with the active database, then drops the temporary database. |
| `pnpm db:create-migration <name>` | Runs `prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script`. It uses no shadow database. It refuses non-additive SQL unless `SOLTRADER_ALLOW_DESTRUCTIVE_MIGRATION=I_UNDERSTAND_THIS_DELETES_DATA` is set. |
| `pnpm db:deploy` | Takes a backup, then runs `prisma migrate deploy`. |
| `pnpm db:migrate` | Runs `prisma migrate dev --create-only`. It works only with a separate `SHADOW_DATABASE_URL`, and takes a backup first. |
| `pnpm db:prisma <args>` | Runs the Prisma CLI, but refuses the following:<ul><li>`migrate reset`</li><li>`db push --force-reset`</li><li>`db push --accept-data-loss`</li><li>`migrate dev`</li><li>a `--shadow-database-url` that equals `DATABASE_URL`</li></ul> |

`pg_dump`, `pg_restore` and `psql` are taken from `PG_BIN`, then `C:\Program Files\PostgreSQL\18\bin`, then `PATH`.

## Shadow database

`prisma/schema.prisma` declares `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`.

- `prisma generate` and `prisma migrate deploy` do not need it.
- If you use `migrate dev`, create a dedicated, empty database whose name contains `shadow`, for example `soltrader_shadow`.

The guard rejects a shadow URL that:

- points at the same server, port and database as `DATABASE_URL` (any schema);
- has a database name without `shadow`.

## Restore procedure (disaster recovery)

1. Verify the dump: run `pnpm db:verify-backup <file>`.
2. Create a new, empty database, for example `soltrader_restored`.
3. Restore into it:

   ```bash
   pg_restore --no-owner --dbname=<new db url> <file>
   ```

4. Point `DATABASE_URL` at the new database.

Never run `pg_restore --clean` against the active database.
