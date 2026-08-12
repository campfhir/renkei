/**
 * The extraction template engine: a sender's notification format expressed
 * as an ordered list of segments (fixed wrapper text, or a named variable
 * span), derived once from a real sample and matched against every later
 * message from that sender. This is the whole registry — onboarding a new
 * templated sender means producing a `TemplateSegment[]`, never writing a
 * parser.
 *
 * Matching walks the literals in order using whitespace-insensitive regexes
 * built from each literal's exact text, so it: (a) tolerates the whitespace
 * reflow that HTML→text linearization introduces, and (b) gets exact
 * character offsets in the ORIGINAL text for free, with no separate
 * normalized-text offset mapping to get wrong.
 */

import type { TemplateSegment, TemplateMatch } from '../types';

/** One field the caller has marked in a sample, by character offset. */
export interface MarkedField {
  name: string;
  start: number;
  end: number;
  pattern?: string;
}

/**
 * Turn a sample body plus user-marked field spans into a template: text
 * outside any marked span becomes a literal segment, each marked span
 * becomes a field segment. This is the entire "teach the system a new
 * format" mechanism — no code, no per-sender parser.
 */
export function deriveTemplate(
  sample: string,
  markedFields: readonly MarkedField[]
): TemplateSegment[] {
  const sorted = [...markedFields]
    .filter((field) => field.end > field.start)
    .sort((a, b) => a.start - b.start);

  const segments: TemplateSegment[] = [];
  let cursor = 0;
  for (const field of sorted) {
    if (field.start < cursor) continue; // overlapping marks: first one wins
    const literal = sample.slice(cursor, field.start);
    if (literal.trim()) segments.push({ type: 'literal', text: literal });
    segments.push({ type: 'field', name: field.name, pattern: field.pattern });
    cursor = field.end;
  }
  const tail = sample.slice(cursor);
  if (tail.trim()) segments.push({ type: 'literal', text: tail });
  return segments;
}

/** A literal's exact text as a case-insensitive, whitespace-collapsing regex. */
function literalToRegex(literal: string): RegExp {
  const words = literal
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'), 'i');
}

/**
 * Match a template against a message body. Literals must occur in order;
 * text between two matched literals becomes the field value in between them.
 * `score` is the fraction of literal segments actually found — below the
 * template's threshold means the sender's format has drifted.
 */
export function matchTemplate(segments: readonly TemplateSegment[], text: string): TemplateMatch {
  const literalCount = segments.filter(
    (segment) => segment.type === 'literal' && segment.text.trim()
  ).length;
  if (literalCount === 0) return { fields: {}, score: 0 };

  let cursor = 0;
  let matchedLiterals = 0;
  const fields: Record<string, string> = {};
  let pendingField: { name: string; start: number; pattern?: string } | null = null;

  /** Narrow a captured span to its constraint pattern when one is set; otherwise take it as-is. */
  function resolveField(raw: string, pattern: string | undefined): string {
    if (!pattern) return raw;
    const constrained = new RegExp(pattern).exec(raw);
    return constrained ? constrained[0] : raw;
  }

  for (const segment of segments) {
    if (segment.type === 'field') {
      pendingField = { name: segment.name, start: cursor, pattern: segment.pattern };
      continue;
    }
    if (!segment.text.trim()) continue;

    const rest = text.slice(cursor);
    const found = literalToRegex(segment.text).exec(rest);
    if (!found) {
      // This literal is missing — any field waiting to be closed by it can't
      // be resolved, but later literals still get a chance from the same cursor.
      pendingField = null;
      continue;
    }

    const matchStart = cursor + found.index;
    const matchEnd = matchStart + found[0].length;
    if (pendingField) {
      const raw = text.slice(pendingField.start, matchStart).trim();
      fields[pendingField.name] = resolveField(raw, pendingField.pattern);
      pendingField = null;
    }
    matchedLiterals += 1;
    cursor = matchEnd;
  }
  if (pendingField) {
    const raw = text.slice(pendingField.start).trim();
    fields[pendingField.name] = resolveField(raw, pendingField.pattern);
  }

  return { fields, score: matchedLiterals / literalCount };
}
