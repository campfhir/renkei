/**
 * Re-encrypt every value the deployment keys seal under the CURRENT key of
 * its ring — the second step of rotating TOKEN_ENCRYPTION_KEY (and the
 * CONTENT / SANDBOX_ENV_SECRETS keys), DEPLOYMENT.md "Rotating
 * TOKEN_ENCRYPTION_KEY". The logic is ../src/rewrap.ts; this is the CLI.
 *
 * Run from packages/user-keys with DATABASE_URL and the rings set — the
 * new key FIRST, the old one behind it:
 *
 *   TOKEN_ENCRYPTION_KEYS=<new>,<old> pnpm rewrap --dry-run   # count only
 *   TOKEN_ENCRYPTION_KEYS=<new>,<old> pnpm rewrap
 *
 * CONTENT_ENCRYPTION_KEYS and SANDBOX_ENV_SECRETS_KEYS the same way when
 * those are set apart from the token key. Batched and resumable: run it
 * again after an interruption and it finishes what is left. Exits 1 when
 * any row could not be opened by the ring, so a rotation runbook can gate
 * dropping the old key on a clean run.
 */

import { getDatabase, closeDatabase } from '@renkei/db';
import { rewrapAll, rewrapRingsFromEnv } from '../src/rewrap';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rings = rewrapRingsFromEnv();
  if (!rings.ok) fail(`Keys: ${rings.message}`);

  const dbResult = getDatabase();
  if (!dbResult.ok) fail('Database unavailable — set DATABASE_URL.');

  try {
    const report = await rewrapAll(dbResult.val, rings.val, {
      dryRun,
      log: (line) => console.log(line),
    });
    const all = [...Object.values(report.targets), report.vapid];
    const rewrapped = all.reduce((n, c) => n + c.rewrapped, 0);
    const skipped = all.reduce((n, c) => n + c.skipped, 0);
    console.log(
      `${dryRun ? 'Would rewrap' : 'Rewrapped'} ${rewrapped} value(s); ${skipped} could not be opened.`
    );
    if (skipped > 0) {
      console.error(
        'Some rows are sealed under a key this ring does not hold. Put that key back behind the current one (TOKEN_ENCRYPTION_KEYS=<current>,<previous>,...) and run again; do not drop the previous key yet.'
      );
      process.exitCode = 1;
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
