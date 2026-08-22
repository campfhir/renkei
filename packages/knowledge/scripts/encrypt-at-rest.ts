/**
 * One-off sweep: encrypt every legacy plaintext knowledge_chunks.content in
 * place. New writes are already encrypted at the upsert seam; readers
 * dual-read both eras, so this can run against a LIVE system, in batches,
 * resumable — killing it mid-run loses nothing but progress.
 *
 * Run from packages/knowledge with DATABASE_URL (and the content key —
 * CONTENT_ENCRYPTION_KEY or the TOKEN_ENCRYPTION_KEY fallback) set:
 *
 *   DATABASE_URL=postgres://… pnpm encrypt-at-rest
 *
 * embedding_jobs payloads are deliberately NOT swept: queue rows drain in
 * minutes and the consumer dual-reads, so the backlog converts itself.
 */

import { getDatabase, closeDatabase } from '@renkei/db';
import { contentEncryptionKey, encryptContent, CONTENT_ENVELOPE_PREFIX } from '@renkei/crypto';

const BATCH = 500;

async function main(): Promise<void> {
  const keyResult = contentEncryptionKey();
  if (!keyResult.ok) {
    console.error(`No content key: ${keyResult.err.message}`);
    process.exit(1);
  }
  const key = keyResult.val;

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    console.error('Database unavailable — set DATABASE_URL.');
    process.exit(1);
  }
  const db = dbResult.val;

  let total = 0;
  for (;;) {
    const rows = await db
      .selectFrom('knowledge_chunks')
      .select(['id', 'content'])
      .where('content', 'not like', `${CONTENT_ENVELOPE_PREFIX}%`)
      .limit(BATCH)
      .execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      await db
        .updateTable('knowledge_chunks')
        .set({ content: encryptContent(row.content, key) })
        .where('id', '=', row.id)
        .execute();
    }
    total += rows.length;
    console.log(`encrypted ${total} chunk(s)…`);
  }

  console.log(`Done — ${total} legacy chunk(s) encrypted.`);
  await closeDatabase();
}

void main();
