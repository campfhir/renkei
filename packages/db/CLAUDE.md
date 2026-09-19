# packages/db

- Adding a migration file under `src/migrations/`? Also add its name to
  `EXPECTED_MIGRATIONS` in `src/migrations/status.ts` (append it, in
  order). `status.test.ts` diffs that list against the files on disk and
  fails the suite — and CI — if the two don't match. Do this in the same
  commit as the migration, not as a follow-up.
