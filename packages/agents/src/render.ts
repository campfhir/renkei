/**
 * Segments → prompt text. The ONLY place chips become words the model sees.
 *
 * Tool chips render as the canonical tool name — the same string the model
 * is offered as a callable tool, so the instruction and the tool list agree.
 * Var chips render as their runtime value; a var with no binding renders as
 * an explicit `(unknown: name)` marker AND is reported back to the caller,
 * because silently rendering nothing would turn a wiring mistake into a
 * model that confidently acts on an empty string.
 *
 * DATE chips render as an already-computed timestamp. That is their whole
 * point: the model is never asked what "yesterday at 19:00 in Los Angeles"
 * is, because by the time it reads the instruction the answer is simply
 * there — resolved here against a real clock and a real timezone database,
 * with the DST handling schedules already rely on.
 */

import type { DateSegment, InstructionSegment } from './steps';
import { describeDateSegment, resolveTime } from './resolve-time';

export interface RenderResult {
  text: string;
  /** Var chips that had no value — recorded on the run as warnings. */
  unbound: string[];
}

/** Minute and hour shifts snap to the hour; larger units to their own. */
function snapUnit(segment: DateSegment): 'hour' | 'day' | 'week' | 'month' {
  switch (segment.unit) {
    case 'minute':
    case 'hour':
      return 'hour';
    case 'week':
      return 'week';
    case 'month':
    case 'year':
      return 'month';
    case 'day':
    default:
      return 'day';
  }
}

/** How a resolved date chip reads in the prompt. */
export function renderDateSegment(segment: DateSegment, now: Date = new Date()): string {
  const resolved = resolveTime(
    {
      timezone: segment.timezone,
      amount: segment.amount,
      unit: segment.unit,
      ...(segment.atTime ? { atTime: segment.atTime } : {}),
      ...(segment.boundary === 'start' ? { startOf: snapUnit(segment) } : {}),
      ...(segment.boundary === 'end' ? { endOf: snapUnit(segment) } : {}),
    },
    now
  );
  // A chip the validator accepted should not fail here; if one somehow
  // does, say so in the prompt rather than emit a plausible-looking wrong
  // date — the exact failure this feature exists to end.
  if (!resolved.ok) return `(unresolved date: ${resolved.error})`;
  switch (segment.format) {
    case 'date':
      return resolved.value.local.slice(0, 10);
    case 'datetime':
      return resolved.value.local;
    case 'iso':
    default:
      return resolved.value.iso;
  }
}

export function renderInstruction(
  segments: InstructionSegment[],
  variables: Record<string, string>,
  /** Injectable clock: one instant for a whole render, and pinnable in tests. */
  now: Date = new Date()
): RenderResult {
  const unbound: string[] = [];
  const parts = segments.map((segment) => {
    switch (segment.t) {
      case 'text':
        return segment.v;
      case 'tool':
        return segment.name;
      case 'date':
        return renderDateSegment(segment, now);
      case 'var': {
        const value = variables[segment.name];
        if (value === undefined) {
          unbound.push(segment.name);
          return `(unknown: ${segment.name})`;
        }
        return value;
      }
    }
  });
  return { text: parts.join(''), unbound };
}

/** The plain-text reading of an instruction, for summaries and history. */
export function instructionPreview(segments: InstructionSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.t) {
        case 'text':
          return segment.v;
        case 'tool':
          return `[${segment.name}]`;
        case 'var':
          return `[${segment.name}]`;
        case 'date':
          // The intent, not a resolved instant: a preview is read long
          // after (and long before) the run that resolves it.
          return `[${describeDateSegment(segment)}]`;
      }
    })
    .join('');
}
