# packages/db

- Adding a migration file under `src/migrations/`? Also add its name to
  `EXPECTED_MIGRATIONS` in `src/migrations/status.ts` (append it, in
  order). `status.test.ts` diffs that list against the files on disk and
  fails the suite — and CI — if the two don't match. Do this in the same
  commit as the migration, not as a follow-up.
- Adding a migration? Also regenerate the memory store's schema:
  `DATABASE_URL=<a migrated database> pnpm db:store-schema`, then prettier
  on `src/store/schema.generated.ts`. CI regenerates it and fails on a diff.
- Changing the data store (`src/store/`)? A repository method changes in
  its domain's `types.ts`, `postgres.ts` and `memory.ts` together, and gets
  a differential scenario in `scenarios.ts`. Run the differential against
  Postgres, not just memory — the memory half alone proves nothing about
  Postgres:
  - once: `CREATE DATABASE renkei_contract TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C.UTF-8'`
    (the ICU collation is the ordering the memory store reproduces), then
    `DATABASE_URL=…/renkei_contract pnpm migrate`;
  - `CONTRACT_DATABASE_URL=…/renkei_contract pnpm test:contract`. The
    harness truncates every table, so it refuses a database whose name
    doesn't end in `_contract`.
