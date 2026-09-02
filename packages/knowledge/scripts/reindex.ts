/**
 * Reindex sweep over knowledge_chunks, for the retrieval changes that
 * altered what a stored row should carry:
 *
 *   --lexical   Backfill `search_text` (migration 079) for rows that have
 *               none. Needs only the content key: the tsvector is built
 *               from the decrypted chunk, its metadata title and whatever
 *               keywords the row holds. Cheap, no provider calls,
 *               resumable — it only touches NULL rows.
 *
 *   --keywords  Extract search keywords (migration 080, keywords.ts) for
 *               every OBJECT whose rows have none, with the tenant's
 *               default LLM model — one call per object, applied to all
 *               its chunks — and rebuild each row's tsvector to carry them
 *               at weight B. Costs one model call per object. Resumable:
 *               only NULL rows are selected, and an object that yields
 *               nothing is stamped with an empty list so it is not asked
 *               again.
 *
 *   --embed     Recompute the vector of every MULTI-chunk row with the
 *               contextual header (context.ts) prepended, the way ingest
 *               now embeds them. Calls each tenant's configured embeddings
 *               endpoint, so it costs what a re-ingest costs, minus the
 *               provider fetches. Single-chunk rows are embedded bare by
 *               ingest too, so they are already right and are skipped.
 *               Idempotent; re-running re-embeds, which is harmless.
 *
 * None is required for correctness: a row without `search_text` still
 * surfaces through the vector arm, a row without keywords still matches
 * on its title and body, and a chunk embedded without its header still
 * ranks — just worse. Re-syncing a source from its connector achieves
 * the same end for that source.
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

import { sql } from 'kysely';
import { getDatabase, closeDatabase } from '@renkei/db';
import { contentEncryptionKey, decryptContent } from '@renkei/crypto';
import {
  resolveEmbeddingProvider,
  resolveKeywordExtractor,
  searchTextFragment,
  titleOf,
  chunkContext,
  embeddingInput,
  vectorLiteral,
} from '../src/index';
import type { EmbeddingProvider, KeywordExtractor } from '../src/index';

const BATCH = 200;
/** Objects per round of the keyword sweep. */
const OBJECT_BATCH = 50;
/** Pieces per embeddings request — the same bound ingest uses. */
const EMBED_BATCH = 64;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function keywordsOf(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((keyword): keyword is string => typeof keyword === 'string')
    : null;
}

function requireDb() {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  return dbResult.val;
}

async function tenantsWithChunks(tenant: string | null): Promise<string[]> {
  const db = requireDb();
  let query = db.selectFrom('knowledge_chunks').select('tenant_id').distinct();
  if (tenant) query = query.where('tenant_id', '=', tenant);
  return (await query.execute()).map((row) => row.tenant_id);
}

async function backfillLexical(key: Buffer, tenant: string | null): Promise<void> {
  const db = requireDb();

  let total = 0;
  let skipped = 0;
  for (;;) {
    let query = db
      .selectFrom('knowledge_chunks')
      .select(['id', 'content', 'metadata', 'keywords'])
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
        .set({
          search_text: searchTextFragment(
            titleOf(metadataOf(row.metadata)),
            keywordsOf(row.keywords),
            opened.val
          ),
        })
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

/** The logical object a chunk row belongs to: its ref before the `#0001` suffix. */
const objectRef = sql<string>`regexp_replace(ref_id, '#[0-9]{4}$', '')`;

async function extractKeywordsTenant(
  tenantId: string,
  extractor: KeywordExtractor,
  key: Buffer
): Promise<{ objects: number; failed: number }> {
  const db = requireDb();

  let objects = 0;
  let failed = 0;
  // Objects the model failed on are left NULL for a re-run, so they must
  // be stepped over within this run or the sweep would spin on them.
  const skip = new Set<string>();
  for (;;) {
    // Objects, not rows: one model call covers every chunk of an object.
    const pending = await db
      .selectFrom('knowledge_chunks')
      .select(['provider', objectRef.as('object_ref')])
      .where('tenant_id', '=', tenantId)
      .where('keywords', 'is', null)
      .groupBy(['provider', objectRef])
      .orderBy('provider')
      .orderBy(objectRef)
      .limit(OBJECT_BATCH + skip.size)
      .execute();
    const todo = pending.filter((row) => !skip.has(`${row.provider} ${row.object_ref}`));
    if (todo.length === 0) break;

    for (const { provider, object_ref: ref } of todo) {
      const rows = await db
        .selectFrom('knowledge_chunks')
        .select(['id', 'ref_id', 'content', 'metadata'])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', provider)
        .where((eb) => eb.or([eb('ref_id', '=', ref), eb('ref_id', 'like', `${ref}#%`)]))
        .orderBy('ref_id')
        .execute();

      const pieces: string[] = [];
      let undecryptable = false;
      for (const row of rows) {
        const opened = decryptContent(row.content, key);
        if (!opened.ok) {
          undecryptable = true;
          break;
        }
        pieces.push(opened.val);
      }
      const metadata = metadataOf(rows[0]?.metadata);
      const title = titleOf(metadata);

      // An object we cannot read gets an empty list so the sweep moves on;
      // a model failure leaves NULL so a re-run retries it.
      let keywords: string[] | null = undecryptable ? [] : null;
      if (!undecryptable) {
        const extracted = await extractor.extract({ title, content: pieces.join('\n\n') });
        if (extracted.ok) keywords = extracted.val;
        else {
          failed += 1;
          skip.add(`${provider} ${ref}`);
          console.error(
            `keywords [${tenantId}]: ${provider}/${ref}: ${extracted.err.message ?? 'failed'}`
          );
        }
      }
      if (keywords === null) continue;

      for (const [index, row] of rows.entries()) {
        await db
          .updateTable('knowledge_chunks')
          .set({
            keywords,
            search_text: searchTextFragment(title, keywords, pieces[index] ?? ''),
          })
          .where('id', '=', row.id)
          .execute();
      }
      objects += 1;
    }
    console.log(`keywords [${tenantId}]: ${objects} object(s) enriched…`);
  }
  return { objects, failed };
}

async function extractKeywords(key: Buffer, tenant: string | null): Promise<void> {
  for (const tenantId of await tenantsWithChunks(tenant)) {
    const extractor = await resolveKeywordExtractor(tenantId);
    if (!extractor) {
      console.log(
        `keywords [${tenantId}]: enrichment off (no default model, or switched off) — skipped`
      );
      continue;
    }
    const { objects, failed } = await extractKeywordsTenant(tenantId, extractor, key);
    console.log(
      `keywords [${tenantId}]: done — ${objects} object(s) enriched` +
        (failed > 0 ? `, ${failed} failed (re-run to retry)` : '')
    );
  }
}

async function reembedTenant(
  tenantId: string,
  embedder: EmbeddingProvider,
  key: Buffer
): Promise<{ done: number; failed: number }> {
  const db = requireDb();

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
  for (const tenantId of await tenantsWithChunks(tenant)) {
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

  // Keywords before lexical: a row the keyword sweep rebuilds already
  // carries its tsvector, so the lexical pass then has less to do.
  if (args.keywords) await extractKeywords(key, args.tenant);
  if (args.lexical) await backfillLexical(key, args.tenant);
  if (args.embed) await reembed(key, args.tenant);

  await closeDatabase();
}

void main();
