/**
 * Embeddings, from outside (RENKEI.md Decision #8: models live outside
 * Renkei). The provider is an OpenAI-compatible /embeddings endpoint whose
 * base URL, model, and API key are org connector configuration in the
 * database (Decision #19) — connector key 'embeddings'. Unconfigured means
 * the knowledge layer is simply off for that org, never an error.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
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

/** pgvector input literal: '[0.1,0.2,…]'. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<Result<number[][], 'EMBEDDING_FAILED'>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS
  ) {}

  async embed(texts: readonly string[]): Promise<Result<number[][], 'EMBEDDING_FAILED'>> {
    if (texts.length === 0) return ok([]);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
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
      return err('EMBEDDING_FAILED' as const, {
        message: `embeddings endpoint returned ${response.status}`,
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
 * The org's embedding provider from connector configuration, or null when
 * the org has not provisioned one (or disabled it) — callers skip indexing
 * and enrichment in that case.
 */
export async function resolveEmbeddingProvider(tenantId: string): Promise<EmbeddingProvider | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;

  const configResult = await readConnectorConfigCached(tenantId, EMBEDDINGS_CONNECTOR, keyResult.val);
  if (!configResult.ok) return null;
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const baseUrl = config.settings.baseUrl;
  const model = config.settings.model;
  const apiKey = config.secrets.apiKey;
  if (typeof baseUrl !== 'string' || !baseUrl || typeof model !== 'string' || !model || !apiKey) {
    return null;
  }

  return new OpenAiCompatibleEmbeddings(baseUrl, apiKey, model);
}
