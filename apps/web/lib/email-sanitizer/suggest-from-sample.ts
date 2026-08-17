/**
 * Paste a sample email body → the org model proposes boilerplate phrases
 * for the banner library (the strip-the-matched-text-only mechanism), so
 * an org's signature blocks and injected footers can be taught from one
 * real example instead of hand-typing each fragment.
 *
 * Boundary note: the sample is content the ADMIN pasted themselves — their
 * own example, supplied for exactly this purpose. Nothing here reads any
 * user's stored mail; the admin content-free rule concerns other people's
 * messages, not text the operator typed into the box.
 *
 * Two server-side checks keep the model honest:
 *  - every proposed phrase must actually MATCH the sample under the same
 *    whitespace-insensitive matching the cleaner uses — a phrase that
 *    would not have stripped anything from the sample is dropped;
 *  - anything at or below a built-in legal-footer anchor is already cut
 *    wholesale by stripLegalFooter, so proposals from that region are
 *    dropped and the response says so instead.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveAgentLlm } from '@renkei/agent-llm';
import { LEGAL_FOOTER_ANCHORS, SEED_BANNERS } from '@renkei/email-sanitizer';
import { logger } from '@/lib/logger';

const SUGGEST_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 1_536;
const MAX_SAMPLE_CHARS = 20_000;
const MAX_PHRASES = 8;
/** Shorter phrases over-match: the library strips wherever a phrase appears. */
const MIN_PHRASE_WORDS = 4;

export interface PhraseSuggestion {
  phrase: string;
  rationale: string;
}

export interface SampleAnalysis {
  phrases: PhraseSuggestion[];
  /** What the built-in cleaners already handle in this sample. */
  alreadyCovered: string[];
}

/** The cleaner's own matching semantics (clean/generic.ts phraseToRegex). */
function phraseMatches(phrase: string, sample: string): boolean {
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'), 'i').test(sample);
}

/** Index of the first legal-footer anchor line, or -1. */
function footerStart(sample: string): number {
  let offset = 0;
  for (const line of sample.split('\n')) {
    const lower = line.toLowerCase();
    if (LEGAL_FOOTER_ANCHORS.some((anchor) => lower.includes(anchor))) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function promptOf(sample: string, existing: string[]): string {
  return [
    'An email sanitizer strips organization boilerplate before messages are indexed. It keeps',
    'a library of literal phrases; each is removed WHEREVER it appears in a message (matching',
    'is case-insensitive and flexible about whitespace/line wraps, but otherwise verbatim).',
    '',
    'Below is a sample email body an administrator pasted. Propose up to ' +
      String(MAX_PHRASES) +
      ' phrases for the library that would strip this organization’s boilerplate from ALL',
    'employees’ mail. Rules:',
    `- Each phrase must appear verbatim in the sample and be at least ${MIN_PHRASE_WORDS} words.`,
    '- Only organization-wide constants: office addresses, social-media link rows, injected',
    '  gateway banners, “follow us” blocks, fixed disclaimers ABOVE any confidentiality notice.',
    '- Never person-specific text (a name, a job title, a direct phone or extension, a personal',
    '  email address) — those differ per sender and would strip nothing from anyone else’s mail.',
    '- Never fragments of a confidentiality/legal notice; a separate detector already removes',
    '  everything from that notice down.',
    '- Do not repeat phrases already in the library.',
    '',
    'Already in the library:',
    existing.length > 0 ? existing.map((phrase) => `- ${phrase}`).join('\n') : '- none',
    '',
    'Sample:',
    '"""',
    sample,
    '"""',
    '',
    'Reply with JSON only, no code fences:',
    '{"phrases": [{"phrase": "…", "rationale": "one sentence on why this is org-wide boilerplate"}]}',
  ].join('\n');
}

export async function suggestBannerPhrasesFromSample(
  db: Kysely<DB>,
  tenantId: string,
  rawSample: string
): Promise<SampleAnalysis | { error: string }> {
  const sample = rawSample.slice(0, MAX_SAMPLE_CHARS);
  if (sample.trim().length < 40) {
    return { error: 'Paste a fuller sample — a few lines are not enough to learn from.' };
  }

  const llmResult = await resolveAgentLlm(db, tenantId, null);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization.' };
  }
  const llm = llmResult.val;

  const alreadyCovered: string[] = [];
  const footerAt = footerStart(sample);
  if (footerAt >= 0) {
    alreadyCovered.push(
      'The confidentiality/legal notice is already handled: everything from its first line ' +
        'down is stripped by the built-in footer detector — no phrase needed for it.'
    );
  }
  // Everything at/below the anchor is gone before phrases ever run, so the
  // model only sees — and may only propose from — the part that survives.
  const strippable = footerAt >= 0 ? sample.slice(0, footerAt) : sample;

  const rows = await db
    .selectFrom('email_banner_patterns')
    .select('phrase')
    .where('tenant_id', '=', tenantId)
    .where('enabled', '=', true)
    .execute();
  const existing = [...SEED_BANNERS, ...rows.map((row) => row.phrase)];
  const existingLower = new Set(existing.map((phrase) => phrase.toLowerCase()));
  for (const phrase of existing) {
    if (phraseMatches(phrase, strippable)) {
      alreadyCovered.push(`Already stripped by the existing library entry “${phrase}”.`);
    }
  }

  // The timer is cleared after the race — left running it would hold the
  // process (and jest) open for the full timeout after a fast answer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = await Promise.race([
    llm.provider.complete({
      system:
        'You extract organization boilerplate from email samples. You reply with strict JSON.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: promptOf(strippable, existing) }] },
      ],
      tools: [],
      maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
    }),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SUGGEST_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (completion === 'timeout') return { error: 'The model took too long — try again.' };
  if (!completion.ok) {
    logger.warn('sample analysis failed: {kind} {message}', {
      component: 'email-sanitizer/suggest',
      tenantId,
      kind: completion.err.type,
      message: completion.err.message?.slice(0, 300) ?? '',
    });
    return { error: 'The model could not analyze the sample — try again later.' };
  }

  const raw = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/```(?:json)?/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'The model gave an unusable answer.' };

  let parsed: { phrases?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: 'The model gave an unusable answer.' };
  }
  if (!Array.isArray(parsed.phrases)) return { error: 'The model proposed nothing.' };

  const phrases: PhraseSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.phrases.slice(0, MAX_PHRASES)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const suggestion: { phrase?: unknown; rationale?: unknown } = entry;
    if (typeof suggestion.phrase !== 'string') continue;
    const phrase = suggestion.phrase.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (phrase.split(' ').length < MIN_PHRASE_WORDS) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key) || existingLower.has(key)) continue;
    // The one check that matters: would this phrase have stripped anything
    // from the sample? A no here means the model paraphrased.
    if (!phraseMatches(phrase, strippable)) continue;
    seen.add(key);
    phrases.push({
      phrase,
      rationale:
        typeof suggestion.rationale === 'string'
          ? suggestion.rationale.slice(0, 300)
          : 'Proposed from the sample.',
    });
  }

  if (phrases.length === 0 && alreadyCovered.length === 0) {
    return { error: 'The model found no org-wide boilerplate it was confident about.' };
  }
  return { phrases, alreadyCovered };
}
