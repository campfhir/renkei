/**
 * Segments → prompt text. The ONLY place chips become words the model sees.
 *
 * Tool chips render as the canonical tool name — the same string the model
 * is offered as a callable tool, so the instruction and the tool list agree.
 * Var chips render as their runtime value; a var with no binding renders as
 * an explicit `(unknown: name)` marker AND is reported back to the caller,
 * because silently rendering nothing would turn a wiring mistake into a
 * model that confidently acts on an empty string.
 */

import type { InstructionSegment } from './steps';

export interface RenderResult {
  text: string;
  /** Var chips that had no value — recorded on the run as warnings. */
  unbound: string[];
}

export function renderInstruction(
  segments: InstructionSegment[],
  variables: Record<string, string>
): RenderResult {
  const unbound: string[] = [];
  const parts = segments.map((segment) => {
    switch (segment.t) {
      case 'text':
        return segment.v;
      case 'tool':
        return segment.name;
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
      }
    })
    .join('');
}
