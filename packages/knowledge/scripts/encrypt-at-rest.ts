/**
 * One-off sweep: encrypt every pre-rollout plaintext
 * knowledge_chunks.content in place. Batched and resumable — killing it
 * mid-run loses nothing but progress.
 *
 * ORDER MATTERS: readers are strict (an unenveloped value renders as
 * "[content unavailable…]", a plaintext queue payload dead-letters), so
 * this sweep must complete — and the embedding queue must drain any
 * pre-encryption payloads — before the strict build serves traffic.
 *
 * Run from packages/knowledge with DATABASE_URL (and the content key —
 * CONTENT_ENCRYPTION_KEY or the TOKEN_ENCRYPTION_KEY fallback) set:
 *
 *   DATABASE_URL=postgres://… pnpm encrypt-at-rest
 */

import { closeDataStore, getDataStore } from '@renkei/db';
import { contentEncryptionKey, encryptContent, CONTENT_ENVELOPE_PREFIX } from '@renkei/crypto';

const BATCH = 500;

async function main(): Promise<void> {
  const keyResult = contentEncryptionKey();
  if (!keyResult.ok) {
    console.error(`No content key: ${keyResult.err.message}`);
    process.exit(1);
  }
  const key = keyResult.val;

  if (!process.env.DATABASE_URL) {
    console.error('Database unavailable — set DATABASE_URL.');
    process.exit(1);
  }
  const chunks = getDataStore().knowledgeChunks;

  let total = 0;
  for (;;) {
    const rows = await chunks.listContentWithoutPrefix(CONTENT_ENVELOPE_PREFIX, BATCH);
    if (rows.length === 0) break;

    for (const row of rows) {
      await chunks.setContent(row.id, encryptContent(row.content, key));
    }
    total += rows.length;
    console.log(`encrypted ${total} chunk(s)…`);
  }

  console.log(`Done — ${total} legacy chunk(s) encrypted.`);
  await closeDataStore();
}

void main();
