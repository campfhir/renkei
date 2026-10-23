/**
 * A digest as a model hands it over — a summary and keywords for the
 * search index (artifact-digest.ts) — made storable: the summary is
 * required and bounded, the keywords distinct and bounded, junk in
 * either dropped rather than failing the whole answer. Pure, so the
 * tools that take a digest beside a file (chat_write_file,
 * chat_write_chart, chat_attach_from_sandbox, artifact_describe) and
 * the turn runner that carries it can share it without the model
 * runner's imports.
 */

export const SUMMARY_MAX_CHARS = 600;
export const KEYWORD_MAX_CHARS = 48;
export const KEYWORDS_MAX = 25;

export interface ArtifactDigest {
  summary: string;
  keywords: string[];
}

/** The two inputs a tool takes beside a file, for the model to fill in as it writes. */
export const DIGEST_INPUT_PROPERTIES = {
  summary: {
    type: 'string',
    description:
      'Two or three plain sentences saying what the file is and what it covers, so the person can find it later under Artifacts by what it is about.',
  },
  keywords: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Eight to twenty short search terms for it: subjects, names, products, systems, identifiers, document type. Each a word or a short phrase.',
  },
} as const;

/** One sentence, bounded, with the whitespace folded. */
function cleanSummary(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
}

/** Distinct, bounded, in the model's order; a term that is only punctuation or whitespace is dropped. */
function cleanKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const term = item.replace(/\s+/g, ' ').trim().slice(0, KEYWORD_MAX_CHARS);
    const key = term.toLowerCase();
    if (!/[\p{L}\p{N}]/u.test(term) || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= KEYWORDS_MAX) break;
  }
  return out;
}

/**
 * A tool call's `summary` and `keywords` as a digest, or null when there
 * is nothing usable in them: a summary is required, keywords may be few.
 */
export function parseDigest(input: unknown): ArtifactDigest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const summary = cleanSummary(Reflect.get(input, 'summary'));
  if (!summary) return null;
  return { summary, keywords: cleanKeywords(Reflect.get(input, 'keywords')) };
}

/**
 * The digest's fields for a `renkeiDocuments` entry, from the tool call
 * that produced the file — nothing when the model gave none, so the
 * entry is as it always was.
 */
export function digestFieldsOf(input: Record<string, unknown>): Partial<ArtifactDigest> {
  const digest = parseDigest(input);
  return digest ? { summary: digest.summary, keywords: digest.keywords } : {};
}
