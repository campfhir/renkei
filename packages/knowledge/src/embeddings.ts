/**
 * Embeddings, from outside (RENKEI.md Decision #8: models live outside
 * Renkei). The provider is an OpenAI-compatible /embeddings endpoint whose
 * base URL, model, and API key are org connector configuration in the
 * database (Decision #19) — connector key 'embeddings'. Unconfigured means
 * the knowledge layer is simply off for that org, never an error.
 *
 * The same connector row carries the per-model calibration retrieval
 * needs: instruction prefixes for asymmetric models, and the distance past
 * which a match is not worth showing. Those belong with the model because
 * they are facts ABOUT the model — change the model, and every one of them
 * changes with it.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { LaneLimiter, type RequestLane } from '@renkei/rate-limit';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export const EMBEDDINGS_CONNECTOR = 'embeddings';

/**
 * Same bound the connector clients use (see connector-webex's client.ts).
 * The provider URL is org configuration pointing at arbitrary infrastructure,
 * which makes it the most likely fetch in the system to hang — and an
 * unbounded hang here once wedged the worker's whole event loop.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Process-scoped, split by lane like every other connector client (see
 * connector-webex's client.ts): a bulk reindex link embeds up to 128 rows
 * (two 64-text requests) with nothing between links pacing the next one, so
 * a large run can fire requests at the provider far faster than a query
 * purpose — the live search path (searchKnowledge) — ever would, and faster
 * than most providers' embeddings-endpoint rate limits allow. `query` maps
 * to the interactive lane, `passage` (ingest and reindex, both background
 * work) to the background one, so a bulk run cannot queue behind a person's
 * live search the way a webhook flood must not either. Capacity is sized
 * above any single test file's call count, not as a tuned production
 * ceiling — the number that actually matters is the background refill
 * rate, which is the one worth raising or lowering per provider.
 */
const limiter = new LaneLimiter({
  interactive: { capacity: 20, refillPerSecond: 10 },
  background: { capacity: 20, refillPerSecond: 3 },
});

function laneOf(purpose: EmbeddingPurpose): RequestLane {
  return purpose === 'query' ? 'interactive' : 'background';
}

/** pgvector input literal: '[0.1,0.2,…]'. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Which side of retrieval a text is on. Asymmetric models (e5, bge, nomic,
 * mxbai served through an OpenAI-compatible endpoint) embed a query and a
 * passage differently and expect a prefix saying which is which; without
 * it they still answer, just worse, and nothing reports why. Symmetric
 * models ignore the distinction, so the default prefixes are empty.
 */
export type EmbeddingPurpose = 'query' | 'passage';

export interface EmbeddingProvider {
  embed(
    texts: readonly string[],
    purpose?: EmbeddingPurpose
  ): Promise<Result<number[][], 'EMBEDDING_FAILED'>>;
}

export interface EmbeddingOptions {
  timeoutMs?: number;
  /** Prepended verbatim to every query text — `query: ` for e5, `search_query: ` for nomic. */
  queryPrefix?: string;
  /** Prepended verbatim to every passage text — `passage: `, `search_document: `. */
  passagePrefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  private readonly timeoutMs: number;
  private readonly queryPrefix: string;
  private readonly passagePrefix: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    options: EmbeddingOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.queryPrefix = options.queryPrefix ?? '';
    this.passagePrefix = options.passagePrefix ?? '';
  }

  async embed(
    texts: readonly string[],
    purpose: EmbeddingPurpose = 'passage'
  ): Promise<Result<number[][], 'EMBEDDING_FAILED'>> {
    if (texts.length === 0) return ok([]);

    const prefix = purpose === 'query' ? this.queryPrefix : this.passagePrefix;
    const input = prefix ? texts.map((text) => `${prefix}${text}`) : [...texts];

    await limiter.take(laneOf(purpose));
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('EMBEDDING_FAILED' as const, {
        message: timedOut
          ? `embeddings endpoint timed out after ${this.timeoutMs}ms`
          : 'embeddings endpoint unreachable',
      });
    }

    if (!response.ok) {
      // The status rides in `cause` (typed `unknown`, so it fits without
      // widening the shared Err type) so a caller that cares — the reindex
      // handler, to tell a transient 429 from a broken endpoint — can
      // branch on the real code instead of parsing it back out of the
      // message.
      return err('EMBEDDING_FAILED' as const, {
        message: `embeddings endpoint returned ${response.status}`,
        cause: response.status,
      });
    }

    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return err('EMBEDDING_FAILED' as const, { message: 'malformed embeddings response' });
    }

    const vectors: number[][] = [];
    for (const entry of body.data) {
      if (!isRecord(entry) || !Array.isArray(entry.embedding)) {
        return err('EMBEDDING_FAILED' as const, { message: 'malformed embedding entry' });
      }
      const vector = entry.embedding.filter((v): v is number => typeof v === 'number');
      if (vector.length !== entry.embedding.length || vector.length === 0) {
        return err('EMBEDDING_FAILED' as const, { message: 'non-numeric embedding entry' });
      }
      vectors.push(vector);
    }
    if (vectors.length !== texts.length) {
      return err('EMBEDDING_FAILED' as const, {
        message: `expected ${texts.length} embeddings, got ${vectors.length}`,
      });
    }

    return ok(vectors);
  }
}

/**
 * The org's retrieval tuning, read from the same connector row as the
 * model. `maxDistance` null means "no cutoff": every candidate the vector
 * proposes is a result, however far — the pre-calibration behaviour, kept
 * as the default because a wrong cutoff hides real answers while a missing
 * one only adds weak ones.
 */
export interface KnowledgeTuning {
  /** Cosine distance past which a semantic-only candidate is dropped and counted as weak. */
  maxDistance: number | null;
}

export interface KnowledgeProvider extends KnowledgeTuning {
  embedder: EmbeddingProvider;
}

/** A finite positive number, or null — anything else is "not configured". */
export function parseMaxDistance(value: unknown): number | null {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function prefixSetting(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The org's embedding provider and retrieval tuning from connector
 * configuration, or null when the org has not provisioned one (or disabled
 * it) — callers skip indexing and enrichment in that case.
 */
export async function resolveKnowledge(tenantId: string): Promise<KnowledgeProvider | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;

  const configResult = await readConnectorConfigCached(
    tenantId,
    EMBEDDINGS_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) return null;
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const baseUrl = config.settings.baseUrl;
  const model = config.settings.model;
  const apiKey = config.secrets.apiKey;
  if (typeof baseUrl !== 'string' || !baseUrl || typeof model !== 'string' || !model || !apiKey) {
    return null;
  }

  return {
    embedder: new OpenAiCompatibleEmbeddings(baseUrl, apiKey, model, {
      queryPrefix: prefixSetting(config.settings.queryPrefix),
      passagePrefix: prefixSetting(config.settings.passagePrefix),
    }),
    maxDistance: parseMaxDistance(config.settings.maxDistance),
  };
}

/** The embedder alone, for callers that only index. */
export async function resolveEmbeddingProvider(
  tenantId: string
): Promise<EmbeddingProvider | null> {
  const resolved = await resolveKnowledge(tenantId);
  return resolved ? resolved.embedder : null;
}
