/**
 * The rollout sweep for sealed agent memory (packages/agents/src/memory.ts):
 * every `agent_memories` row still in plaintext is sealed under its agent
 * owner's automation key through the delegate, the way a new entry is
 * written. The readers accept a plaintext row until it is moved, so this
 * runs after the deploy, as often as wanted, until it reports nothing
 * left; a row already sealed is skipped.
 *
 * The delegate seals only for an owner whose automation delegation is
 * live (they have signed in within their window). Owners without one are
 * reported and skipped — run again after they sign in. From this
 * package, with the worker's own environment (DATABASE_URL,
 * DELEGATE_WORKER_URL, DELEGATE_WORKER_API_KEY):
 *
 *   pnpm --filter @renkei/worker-agents rekey-agent-memories
 *   pnpm --filter @renkei/worker-agents rekey-agent-memories --dry-run
 */

import { closeDatabase, getDataStore } from '@renkei/db';
import { delegateClient } from '@renkei/delegate-client';
import { USER_ENVELOPE_PREFIX } from '@renkei/crypto';

const BATCH = 200;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.');
  const agents = getDataStore().agents;
  const delegate = delegateClient();

  let sealed = 0;
  const skippedOwners = new Map<string, string>();
  let lastId: string | null = null;
  for (;;) {
    const rows = await agents.listPlaintextMemory({
      afterId: lastId,
      sealedPrefix: USER_ENVELOPE_PREFIX,
      limit: BATCH,
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    // One delegate call per owner in the batch.
    const byOwner = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.ownerSubject;
      byOwner.set(key, [...(byOwner.get(key) ?? []), row]);
    }
    for (const [key, owned] of byOwner) {
      if (skippedOwners.has(key)) continue;
      const owner = owned[0].ownerSubject;
      if (dryRun) {
        sealed += owned.length;
        continue;
      }
      const envelopes = await delegate.sealForSubject(
        owner,
        owned.map((row) => row.content),
        'automation'
      );
      if (!envelopes.ok) {
        skippedOwners.set(key, envelopes.err.type);
        continue;
      }
      for (const [index, row] of owned.entries()) {
        // Only if nothing re-sealed it meanwhile (a compaction, say).
        await agents.replaceMemoryContent(row.id, row.content, envelopes.val[index]);
        sealed += 1;
      }
    }
  }

  console.log(
    `${dryRun ? 'Would seal' : 'Sealed'} ${sealed} agent memory row(s)` +
      (skippedOwners.size > 0
        ? `; skipped ${skippedOwners.size} owner(s) whose key is not delegated right now ` +
          `(${[...new Set(skippedOwners.values())].join(', ')}) — run again after they sign in.`
        : '.')
  );
  await closeDatabase();
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
