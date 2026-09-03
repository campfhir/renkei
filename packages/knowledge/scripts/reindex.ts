/**
 * Reindex sweep over knowledge_chunks, from the command line — the same
 * batches the admin buttons on the Embeddings card run through the
 * embedding queue (src/reindex.ts holds the work; this is a loop around
 * it), for operators who would rather run it from a shell, or across every
 * tenant at once.
 *
 *   --lexical   Backfill `search_text` (migration 079) for rows that have
 *               none. Needs only the content key. Resumable: touches only
 *               NULL rows.
 *   --keywords  Extract search keywords (migration 080) for objects that
 *               have none, with each tenant's default model — one call per
 *               object. Honours the org's keyword settings: an org with
 *               enrichment off is skipped.
 *   --embed     Recompute the vector of every multi-chunk row with its
 *               contextual header. Calls each tenant's embeddings endpoint.
 *
 * Run from packages/knowledge with DATABASE_URL, the content key
 * (CONTENT_ENCRYPTION_KEY or the TOKEN_ENCRYPTION_KEY fallback) and, for
 * --embed and --keywords, TOKEN_ENCRYPTION_KEY (the connector and model
 * configs are encrypted with it):
 *
 *   DATABASE_URL=postgres://… pnpm reindex --lexical
 *   DATABASE_URL=postgres://… pnpm reindex --keywords [--tenant <uuid>]
 *   DATABASE_URL=postgres://… pnpm reindex --embed [--tenant <uuid>]
 *   DATABASE_URL=postgres://… pnpm reindex --lexical --keywords --embed
 */

import { getDatabase, closeDatabase } from '@renkei/db';
import { contentEncryptionKey } from '@renkei/crypto';
import {
  resolveEmbeddingProvider,
  resolveKeywordExtractor,
  reindexLexicalBatch,
  reembedBatch,
  extractKeywordsBatch,
} from '../src/index';

const LEXICAL_BATCH = 200;
const EMBED_BATCH = 128;
const KEYWORD_BATCH = 25;

interface Args {
  lexical: boolean;
  keywords: boolean;
  embed: boolean;
  tenant: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { lexical: false, keywords: false, embed: false, tenant: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lexical') args.lexical = true;
    else if (arg === '--keywords') args.keywords = true;
    else if (arg === '--embed') args.embed = true;
    else if (arg === '--tenant') {
      args.tenant = argv[index + 1] ?? null;
      index += 1;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.lexical && !args.keywords && !args.embed) {
    console.error('nothing to do: pass --lexical, --keywords, --embed, or a combination');
    process.exit(2);
  }
  return args;
}

async function tenantsWithChunks(tenant: string | null): Promise<string[]> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  let query = dbResult.val.selectFrom('knowledge_chunks').select('tenant_id').distinct();
  if (tenant) query = query.where('tenant_id', '=', tenant);
  return (await query.execute()).map((row) => row.tenant_id);
}

async function lexical(key: Buffer, tenant: string | null): Promise<void> {
  let processed = 0;
  let skipped = 0;
  for (;;) {
    const batch = await reindexLexicalBatch(tenant, key, LEXICAL_BATCH);
    if (!batch.ok) {
      throw new Error(
        `lexical: the knowledge store could not be updated: ${batch.err.message ?? ''}`
      );
    }
    processed += batch.val.processed;
    skipped += batch.val.skipped;
    console.log(`lexical: ${processed} row(s) indexed…`);
    if (batch.val.done) break;
  }
  console.log(
    `lexical: done — ${processed} row(s) indexed` +
      (skipped > 0 ? `, ${skipped} undecryptable row(s) given an empty entry` : '')
  );
}

async function keywords(key: Buffer, tenant: string | null): Promise<void> {
  for (const tenantId of await tenantsWithChunks(tenant)) {
    const extractor = await resolveKeywordExtractor(tenantId);
    if (!extractor) {
      console.log(`keywords [${tenantId}]: enrichment off, or no default model — skipped`);
      continue;
    }
    const skip = new Set<string>();
    let processed = 0;
    for (;;) {
      const batch = await extractKeywordsBatch(tenantId, extractor, key, KEYWORD_BATCH, skip);
      if (!batch.ok) {
        throw new Error(
          `keywords [${tenantId}]: the knowledge store could not be updated: ${batch.err.message ?? ''}`
        );
      }
      for (const entry of batch.val.skip) skip.add(entry);
      processed += batch.val.processed;
      console.log(`keywords [${tenantId}]: ${processed} object(s) enriched…`);
      if (batch.val.done) break;
    }
    console.log(
      `keywords [${tenantId}]: done — ${processed} object(s) enriched` +
        (skip.size > 0 ? `, ${skip.size} failed (re-run to retry)` : '')
    );
  }
}

async function embed(key: Buffer, tenant: string | null): Promise<void> {
  for (const tenantId of await tenantsWithChunks(tenant)) {
    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) {
      console.log(`embed [${tenantId}]: no embedding provider configured — skipped`);
      continue;
    }
    let cursor: string | null = null;
    let processed = 0;
    let skipped = 0;
    for (;;) {
      const batch = await reembedBatch(tenantId, embedder, key, cursor, EMBED_BATCH);
      if (!batch.ok) {
        throw new Error(
          `embed [${tenantId}]: ${batch.err.type === 'EMBEDDING_FAILED' ? 'embedding failed' : 'the knowledge store could not be updated'}: ${batch.err.message ?? ''}`
        );
      }
      processed += batch.val.processed;
      skipped += batch.val.skipped;
      cursor = batch.val.cursor;
      console.log(`embed [${tenantId}]: ${processed} row(s) re-embedded…`);
      if (batch.val.done) break;
    }
    console.log(
      `embed [${tenantId}]: done — ${processed} row(s) re-embedded` +
        (skipped > 0 ? `, ${skipped} undecryptable row(s) skipped` : '')
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

  if (!getDatabase().ok) {
    console.error('Database unavailable — set DATABASE_URL.');
    process.exit(1);
  }

  // Keywords before lexical: a row the keyword pass rebuilds already
  // carries its tsvector, so the lexical pass then has less to do.
  if (args.keywords) await keywords(key, args.tenant);
  if (args.lexical) await lexical(key, args.tenant);
  if (args.embed) await embed(key, args.tenant);

  await closeDatabase();
}

void main();
