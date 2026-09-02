/**
 * LLM keyword enrichment for the lexical index.
 *
 * The tsvector built at ingest ranks a chunk by the words it happens to
 * contain. A document is often ABOUT something it never quite says: a
 * Jira ticket whose description names the product by nickname, a mail
 * thread that discusses "the renewal" without once writing "vendor
 * contract", a design doc that spells out an acronym exactly once, in the
 * intro chunk. Asking the org's default model for the keywords and phrases
 * a person would search for — proper nouns, identifiers, topic phrases —
 * and indexing those at weight B (above the body, below the title) lets
 * the lexical arm find a document by what it is about, not only by what
 * it literally says.
 *
 * One call per OBJECT, not per chunk, on the object's whole text (capped):
 * the keywords describe the document, every chunk of it carries them, and
 * that costs a 60k-char page one call rather than thirty.
 *
 * Off by default, as an org setting (`knowledgeKeywordEnrichment`): it is
 * one model call per indexed item, which for a mailbox backfill is the
 * dominant cost of ingestion, so an org opts in knowing that. And even
 * when on, items below `knowledgeKeywordMinChars` are not sent: a
 * one-line chat message or a two-sentence mail has nothing a model can
 * add over its own words, and skipping them is the difference between
 * paying per document and paying per message.
 *
 * Failure policy: enrichment, never a gate. No default model, the setting
 * off, a timeout, a malformed reply — each of those means "no keywords
 * this time", and the object still indexes with its title and body. An
 * LLM outage must not stop the index from growing.
 *
 * The keywords are stored in the clear (`knowledge_chunks.keywords`),
 * which is the same at-rest trade-off the tsvector already makes (see
 * migration 079), extended by one notch: a phrase is more legible than a
 * lexeme. What they are for — the lexical index and a "Keywords" line on
 * the result card — needs them readable.
 */

import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { resolveAgentLlm } from '@renkei/agent-llm';
import type { LlmProvider } from '@renkei/agent-llm';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface KeywordExtractor {
  extract(input: { title: string; content: string }): Promise<Result<string[], 'KEYWORDS_FAILED'>>;
}

/**
 * How much of an object the model sees. A document's identifying terms
 * cluster at the front (title, summary, description, first sections), so
 * a cap here loses little and bounds the per-object cost; 12k chars is a
 * few thousand tokens for any current model.
 */
export const KEYWORD_INPUT_MAX_CHARS = 12_000;
export const MAX_KEYWORDS = 20;
/** A "keyword" longer than this is a sentence, and would swamp the weight-B slot. */
const MAX_KEYWORD_CHARS = 60;
/** Twenty short phrases as a JSON array is well under this. */
const MAX_OUTPUT_TOKENS = 300;
/** Bounded tighter than an agent step: this runs inside every ingest. */
const TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You index documents for an enterprise search engine. You reply with strict JSON and ' +
  'nothing else — no prose, no code fences.';

export function keywordPrompt(title: string, content: string): string {
  const body =
    content.length > KEYWORD_INPUT_MAX_CHARS
      ? `${content.slice(0, KEYWORD_INPUT_MAX_CHARS)}\n[…truncated]`
      : content;
  return (
    'Extract the search keywords and key phrases a person would type to find the document ' +
    'below. Prefer, in this order: proper nouns (people, teams, customers, products, systems, ' +
    'places); identifiers (ticket keys, file names, version numbers, error codes, invoice or ' +
    'PO numbers); and specific topic phrases of one to four words, including acronyms and their ' +
    'expansions. Exclude generic words, the kind of document it is, dates, and anything not ' +
    `actually in the text. Return a JSON array of up to ${MAX_KEYWORDS} strings, most ` +
    'important first.\n\n' +
    (title ? `Title: ${title}\n\n` : '') +
    `Document:\n${body}`
  );
}

/**
 * The model's reply as a clean keyword list.
 *
 * Tolerant on purpose: a model told "strict JSON" still sometimes fences
 * it, prefixes it with a sentence, or falls back to one-per-line. Anything
 * that reads as a list is accepted; a reply with no list in it yields
 * nothing rather than one keyword made of the whole reply.
 */
export function parseKeywords(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let candidates: unknown[] | null = null;
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) candidates = parsed;
    } catch {
      candidates = null;
    }
  }
  if (candidates === null) {
    // No JSON array: read it as lines or a comma list, whichever it looks like.
    const lines = trimmed.split('\n').filter((line) => line.trim());
    candidates = lines.length > 1 ? lines : trimmed.split(',');
  }

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate
      .replace(/^[\s\-*•\d.)]+/, '') // list bullets and numbering
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length > MAX_KEYWORD_CHARS) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(cleaned);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

export interface KeywordExtractorOptions {
  /**
   * Content shorter than this (trimmed, in characters) is not sent — an
   * empty list comes back without a model call. 0 sends everything.
   */
  minChars?: number;
}

export function createLlmKeywordExtractor(
  provider: LlmProvider,
  options: KeywordExtractorOptions = {}
): KeywordExtractor {
  const minChars = Math.max(0, options.minChars ?? 0);
  return {
    async extract({ title, content }) {
      const trimmed = content.trim();
      // Too short to be worth a call: the words it has ARE its keywords,
      // and the lexical index already holds those at weight C.
      if (!trimmed || trimmed.length < minChars) return ok([]);
      const completion = await provider.complete({
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: [{ type: 'text', text: keywordPrompt(title, content) }] },
        ],
        tools: [],
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        timeoutMs: TIMEOUT_MS,
      });
      if (!completion.ok) {
        return err('KEYWORDS_FAILED' as const, {
          message: `keyword extraction failed: ${completion.err.type}`,
        });
      }
      const text = completion.val.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return ok(parseKeywords(text));
    },
  };
}

/**
 * The org's keyword extractor, or null when enrichment is off for it —
 * never an error, mirroring resolveEmbeddingProvider. Off means: the org
 * setting is off (the default), or the org has no default model to ask.
 * The extractor carries the org's minimum size, so a caller need not
 * know about it: a short item simply comes back with no keywords.
 */
export async function resolveKeywordExtractor(tenantId: string): Promise<KeywordExtractor | null> {
  const settings = await getOrgSettings(tenantId);
  if (!settings.ok || !settings.val.knowledgeKeywordEnrichment) return null;

  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const llm = await resolveAgentLlm(dbResult.val, tenantId, null);
  if (!llm.ok) return null;
  return createLlmKeywordExtractor(llm.val.provider, {
    minChars: settings.val.knowledgeKeywordMinChars,
  });
}
