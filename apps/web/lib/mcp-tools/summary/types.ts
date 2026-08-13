/**
 * The daily-summary contract.
 *
 * Renkei does not write the summary. It has no language model — the one thing
 * here that sounds like it does, `analyze_transcript`, says in its own header
 * that it is pattern matching rather than comprehension. So every collector
 * returns COMPACT STRUCTURED MATERIAL and the calling model turns it into
 * prose.
 *
 * That is not a limitation being worked around, it is the better shape. One
 * model holding every connector's material at once can say "the Acme thread
 * is about ENG-717, which is still in review" — a cross-reference that N
 * independent server-side summaries stitched together structurally cannot
 * make. It also keeps org content off any new egress path, which would
 * otherwise land on the disclosure gate.
 *
 * A collector's job is therefore: fetch what happened in the period, throw
 * away the noise, cap what is left, and be honest about what it dropped.
 */

import type { MCPToolContext } from '../common';

export interface SummaryPeriod {
  /** Inclusive ISO-8601 lower bound. */
  start: string;
  /** Exclusive ISO-8601 upper bound. */
  end: string;
  /** How a person would say it: "today", "yesterday", "the last 7 days". */
  label: string;
  /** IANA zone the bounds were computed in — "today" is meaningless without it. */
  timeZone: string;
}

export interface SummarySection {
  /** Capability key, so the orchestrator can report what it skipped and why. */
  connector: string;
  /** "Calendar", "Unread mail", "Sprint" — what a reader would call it. */
  label: string;
  /** One-line count or state, when there is one: "12 unread", "3 meetings". */
  headline?: string;
  /** Short factual lines. The model turns these into prose; keep them terse. */
  lines: string[];
  /**
   * Longer material — email bodies, meeting transcripts — already capped by
   * the collector. Separate from `lines` so the orchestrator can drop it
   * first when a summary is too large, without losing the skeleton.
   */
  detail?: string;
  /**
   * What was left out, in words. Load-bearing: a model told "12 unread" and
   * shown 5 will otherwise describe those 5 as the lot. Anything a collector
   * truncates it must say here.
   */
  omitted?: string;
}

/**
 * Fetch one connector's material for a period. Returns null when there is
 * nothing to say — an empty section is noise in the composed summary.
 *
 * Must not throw: one connector being down should cost its section, not the
 * whole summary. Errors come back as a section whose `omitted` explains.
 */
export type SummaryCollector = (
  context: MCPToolContext,
  period: SummaryPeriod
) => Promise<SummarySection | null>;

export interface SummaryProvider {
  /** Capability key — matches what the capability gate and disabledConnectors use. */
  connector: string;
  label: string;
  /** The standalone tool this provider also backs, e.g. `outlook_summary`. */
  toolName: string;
  collect: SummaryCollector;
}

/** Per-item text ceiling, so one long email or transcript cannot crowd out the rest. */
export const DETAIL_ITEM_MAX_CHARS = 1_500;
/** Per-section ceiling across all its detail. */
export const DETAIL_SECTION_MAX_CHARS = 8_000;
/** How many items a collector lists before it starts saying "and N more". */
export const MAX_ITEMS_PER_SECTION = 15;

/** Clip to a budget, returning the text and whether anything was lost. */
export function clip(text: string, maxChars: number): { text: string; clipped: boolean } {
  const trimmed = text.trim().replace(/\s+\n/g, '\n');
  if (trimmed.length <= maxChars) return { text: trimmed, clipped: false };
  return { text: `${trimmed.slice(0, maxChars)}…`, clipped: true };
}

/** Render a section as the text the model reads. */
export function renderSection(section: SummarySection): string {
  const head = section.headline ? `${section.label} — ${section.headline}` : section.label;
  const body = section.lines.length > 0 ? section.lines.map((line) => `  ${line}`).join('\n') : '';
  const detail = section.detail ? `\n${section.detail}` : '';
  const omitted = section.omitted ? `\n  (${section.omitted})` : '';
  return `## ${head}\n${body}${detail}${omitted}`.trimEnd();
}
