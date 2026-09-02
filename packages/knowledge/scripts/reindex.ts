/**
 * Reindex sweep over knowledge_chunks, for the two retrieval changes that
 * altered what a stored row should carry:
 *
 *   --lexical   Backfill `search_text` (migration 079) for rows that have
 *               none. Needs only the content key: the tsvector is built
 *               from the decrypted chunk and its metadata title. Cheap, no
 *               provider calls, resumable — it only touches NULL rows.
 *
 *   --embed     Recompute the vector of every MULTI-chunk row with the
 *               contextual header (context.ts) prepended, the way ingest
 *               now embeds them. Calls each tenant's configured embeddings
 *               endpoint, so it costs what a re-ingest costs, minus the
 *               provider fetches. Single-chunk rows are embedded bare by
 *               ingest too, so they are already right and are skipped.
 *               Idempotent; re-running re-embeds, which is harmless.
 *
 * Neither is required for correctness: a row without `search_text` still
 * surfaces through the vector arm, and a chunk embedded without its
 * header still ranks — just worse. Re-syncing a source from its connector
 * achieves the same end for that source.
 *
 * Run from packages/knowledge with DATABASE_URL, the content key
 * (CONTENT_ENCRYPTION_KEY or the TOKEN_ENCRYPTION_KEY fallback) and, for
 * --embed, TOKEN_ENCRYPTION_KEY (the connector config is encrypted with
 * it):
 *
 *   DATABASE_URL=postgres://… pnpm reindex --lexical
 *   DATABASE_URL=postgres://… pnpm reindex --embed [--tenant <uuid>]
 *   DATABASE_URL=postgres://… pnpm reindex --lexical --embed
 */

import { sql } from 'kysely';
import { getDatabase, closeDatabase } from '@renkei/db';
import { contentEncryptionKey, decryptContent } from '@renkei/crypto';
import {
  resolveEmbeddingProvider,
  searchTextFragment,
  titleOf,
  chunkContext,
  embeddingInput,
  vectorLiteral,
} from '../src/index';
import type { EmbeddingProvider } from '../src/index';

const BATCH = 200;
/** Pieces per embeddings request — the same bound ingest uses. */
const EMBED_BATCH = 64;

interface Args {
  lexical: boolean;
  embed: boolean;
  tenant: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { lexical: false, embed: false, tenant: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lexical') args.lexical = true;
    else if (arg === '--embed') args.embed = true;
    else if (arg === '--tenant') {
      args.tenant = argv[index + 1] ?? null;
      index += 1;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.lexical && !args.embed) {
    console.error('nothing to do: pass --lexical, --embed, or both');
    process.exit(2);
  }
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function backfillLexical(key: Buffer, tenant: string | null): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  let total = 0;
  let skipped = 0;
  for (;;) {
    let query = db
      .selectFrom('knowledge_chunks')
      .select(['id', 'content', 'metadata'])
      .where('search_text', 'is', null)
      .orderBy('id')
      .limit(BATCH);
    if (tenant) query = query.where('tenant_id', '=', tenant);
    const rows = await query.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      const opened = decryptContent(row.content, key);
      if (!opened.ok) {
        // Wrong key or a pre-encryption row: give it an empty entry so the
        // sweep terminates rather than re-selecting it forever, and say so.
        skipped += 1;
        await db
          .updateTable('knowledge_chunks')
          .set({ search_text: sql<string>`to_tsvector('')` })
          .where('id', '=', row.id)
          .execute();
        continue;
      }
      await db
        .updateTable('knowledge_chunks')
        .set({ search_text: searchTextFragment(titleOf(metadataOf(row.metadata)), opened.val) })
        .where('id', '=', row.id)
        .execute();
    }
    total += rows.length;
    console.log(`lexical: ${total} row(s) processed…`);
  }
  console.log(
    `lexical: done — ${total - skipped} row(s) indexed` +
      (skipped > 0 ? `, ${skipped} undecryptable row(s) given an empty entry` : '')
  );
}

async function reembedTenant(
  tenantId: string,
  embedder: EmbeddingProvider,
  key: Buffer
): Promise<{ done: number; failed: number }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  let done = 0;
  let failed = 0;
  let afterId = '';
  for (;;) {
    const rows = await db
      .selectFrom('knowledge_chunks')
      .select(['id', 'content', 'metadata'])
      .where('tenant_id', '=', tenantId)
      // Only multi-chunk rows carry a header; ingest stamps `chunkCount` on
      // exactly those.
      .where(sql<boolean>`(metadata ->> 'chunkCount')::int > 1`)
      .where('id', '>', afterId)
      .orderBy('id')
      .limit(BATCH)
      .execute();
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]?.id ?? afterId;

    const inputs: { id: string; text: string }[] = [];
    for (const row of rows) {
      const opened = decryptContent(row.content, key);
      if (!opened.ok) {
        failed += 1;
        continue;
      }
      inputs.push({
        id: row.id,
        text: embeddingInput(chunkContext(metadataOf(row.metadata)), opened.val),
      });
    }

    for (let at = 0; at < inputs.length; at += EMBED_BATCH) {
      const slice = inputs.slice(at, at + EMBED_BATCH);
      const embedded = await embedder.embed(
        slice.map((input) => input.text),
        'passage'
      );
      if (!embedded.ok) {
        console.error(`embed: ${embedded.err.message ?? 'embedding failed'} — batch skipped`);
        failed += slice.length;
        continue;
      }
      for (const [index, input] of slice.entries()) {
        const vector = embedded.val[index];
        if (!vector) continue;
        await db
          .updateTable('knowledge_chunks')
          .set({ embedding: sql`${vectorLiteral(vector)}::vector` })
          .where('id', '=', input.id)
          .execute();
        done += 1;
      }
    }
    console.log(`embed [${tenantId}]: ${done} row(s) re-embedded…`);
  }
  return { done, failed };
}

async function reembed(key: Buffer, tenant: string | null): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;

  let tenantQuery = db.selectFrom('knowledge_chunks').select('tenant_id').distinct();
  if (tenant) tenantQuery = tenantQuery.where('tenant_id', '=', tenant);
  const tenants = await tenantQuery.execute();

  for (const { tenant_id: tenantId } of tenants) {
    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) {
      console.log(`embed [${tenantId}]: no embedding provider configured — skipped`);
      continue;
    }
    const { done, failed } = await reembedTenant(tenantId, embedder, key);
    console.log(
      `embed [${tenantId}]: done — ${done} row(s) re-embedded` +
        (failed > 0 ? `, ${failed} row(s) failed (re-run to retry)` : '')
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  if (args.lexical) await backfillLexical(key, args.tenant);
  if (args.embed) await reembed(key, args.tenant);

  await closeDatabase();
}

void main();
