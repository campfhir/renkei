/**
 * Reindex sweep over knowledge_chunks, from the command line — the same
 * batches the admin buttons on the Embeddings card run through the
 * embedding queue (src/reindex.ts holds the work; this is a loop around
 * it), for operators who would rather run it from a shell.
 *
 *   --lexical   Backfill `search_text` (migration 079) for rows that have
 *               none. Needs only the content key. Resumable: touches only
 *               NULL rows.
 *   --keywords  Extract search keywords (migration 080) for objects that
 *               have none, with the org's default model — one call per
 *               object. Honours the org's keyword settings: with
 *               enrichment off it is skipped.
 *   --embed     Recompute the vector of every multi-chunk row with its
 *               contextual header. Calls the org's embeddings endpoint.
 *
 * Run from packages/knowledge with DATABASE_URL, the content key
 * (CONTENT_ENCRYPTION_KEY or the TOKEN_ENCRYPTION_KEY fallback) and, for
 * --embed and --keywords, TOKEN_ENCRYPTION_KEY (the connector and model
 * configs are encrypted with it):
 *
 *   DATABASE_URL=postgres://… pnpm reindex --lexical
 *   DATABASE_URL=postgres://… pnpm reindex --keywords
 *   DATABASE_URL=postgres://… pnpm reindex --embed
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
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { lexical: false, keywords: false, embed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lexical') args.lexical = true;
    else if (arg === '--keywords') args.keywords = true;
    else if (arg === '--embed') args.embed = true;
    else {
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

async function lexical(key: Buffer): Promise<void> {
  let processed = 0;
  let skipped = 0;
  for (;;) {
    const batch = await reindexLexicalBatch(key, LEXICAL_BATCH);
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

async function keywords(key: Buffer): Promise<void> {
  {
    const extractor = await resolveKeywordExtractor();
    if (!extractor) {
      console.log('keywords: enrichment off, or no default model — skipped');
      return;
    }
    const skip = new Set<string>();
    let processed = 0;
    for (;;) {
      const batch = await extractKeywordsBatch(extractor, key, KEYWORD_BATCH, skip);
      if (!batch.ok) {
        throw new Error(
          `keywords: the knowledge store could not be updated: ${batch.err.message ?? ''}`
        );
      }
      for (const entry of batch.val.skip) skip.add(entry);
      processed += batch.val.processed;
      console.log(`keywords: ${processed} object(s) enriched…`);
      if (batch.val.done) break;
    }
    console.log(
      `keywords: done — ${processed} object(s) enriched` +
        (skip.size > 0 ? `, ${skip.size} failed (re-run to retry)` : '')
    );
  }
}

async function embed(key: Buffer): Promise<void> {
  {
    const embedder = await resolveEmbeddingProvider();
    if (!embedder) {
      console.log('embed: no embedding provider configured — skipped');
      return;
    }
    let cursor: string | null = null;
    let processed = 0;
    let skipped = 0;
    for (;;) {
      const batch = await reembedBatch(embedder, key, cursor, EMBED_BATCH);
      if (!batch.ok) {
        throw new Error(
          `embed: ${batch.err.type === 'EMBEDDING_FAILED' ? 'embedding failed' : 'the knowledge store could not be updated'}: ${batch.err.message ?? ''}`
        );
      }
      processed += batch.val.processed;
      skipped += batch.val.skipped;
      cursor = batch.val.cursor;
      console.log(`embed: ${processed} row(s) re-embedded…`);
      if (batch.val.done) break;
    }
    console.log(
      `embed: done — ${processed} row(s) re-embedded` +
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
  if (args.keywords) await keywords(key);
  if (args.lexical) await lexical(key);
  if (args.embed) await embed(key);

  await closeDatabase();
}

void main();
