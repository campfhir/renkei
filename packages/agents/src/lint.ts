/**
 * Hints, not rules: what is worth a second look in a draft the validator
 * accepts.
 *
 * A step's model sees only the variables its chips name (step-prompts.ts,
 * knownVariables). Prose that leans on a value without a chip — "comment on
 * the ticket", "reply to the message" — is valid, saves, and runs; the step
 * just never receives the ticket or the message, and nothing at run time
 * says so because nothing was unbound. This is the deterministic check for
 * that gap, run client-side by the builder and echoed by the MCP save
 * tools. Two shapes:
 *
 *   1. The text names a variable the step could chip — an earlier step's
 *      saved result, a finished loop's collected list, or a trigger value
 *      by its name ("nearby messages", "trigger.subject") — without the
 *      chip. One chip fixes it, and `chipMention` applies that fix.
 *   2. The text talks about the thing that started the run ("the email",
 *      "this message") while chipping none of the trigger's values. Which
 *      value it needs is the author's call, so this one only points.
 *
 * Both are heuristics over words, so they are hints: never a save block,
 * and a mention the author meant loosely costs one dismissal, not a fight
 * with the editor.
 */

import {
  isActionStepNode,
  varSegments,
  walkSteps,
  type AgentStepNode,
  type AgentStepsDoc,
  type InstructionSegment,
} from './steps';
import { triggerEventById } from './trigger-catalog';
import { triggerVariableNames, type TriggerDraft } from './triggers';
import { isAlwaysKnown } from './variables';

/** Where in a segment list a mention sits: the text segment and its span. */
export interface Mention {
  segment: number;
  start: number;
  end: number;
}

export interface LintHint {
  /** The segment list it is about: 'steps.2.instruction', 'steps.2.failureHandling.0', 'steps.3.condition'. */
  path: string;
  /** Plain language, shown verbatim in the builder. */
  message: string;
  /** Set when one chip fixes it: the variable the text names. */
  variable?: string;
  /** The words that triggered it, for the builder to chip in place. */
  at: Mention;
}

/**
 * What prose calls the event behind each catalog trigger. A bare noun is
 * too loose ("a message to the team" is not the trigger), so the check
 * wants a determiner in front: "the email", "this message", "the incoming
 * transcript".
 */
const EVENT_NOUNS: Record<string, readonly string[]> = {
  'microsoft/mail.received': ['email', 'e-mail', 'mail', 'message'],
  'webex/message.received': ['message', 'post'],
  'zoom/recording.transcript_completed': ['transcript', 'recording', 'meeting'],
  'zoom/meeting.summary_completed': ['summary', 'meeting'],
  'batch/job.completed': ['batch', 'job'],
  'batch/job.started': ['batch', 'job'],
};

const DETERMINERS = '(?:the|this|that|its|incoming|triggering|original|new)';

/** Shortest bare trigger key worth matching: "text", "body" and "from" are everyday words. */
const MIN_BARE_KEY = 5;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-phrase, case-insensitive, letters and digits on neither side. */
function phrasePattern(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escape(phrase)}(?![\\p{L}\\p{N}_])`, 'iu');
}

/** "nearbyMessages" → "nearby messages", so prose can name a camelCase key. */
function spaced(key: string): string {
  return key.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The ways prose can name one variable, longest first so "trigger.text" wins over "text". */
function phrasesFor(name: string): string[] {
  const phrases = [name];
  if (name.startsWith('trigger.')) {
    const key = name.slice('trigger.'.length);
    if (key.length >= MIN_BARE_KEY) {
      phrases.push(key);
      const words = spaced(key);
      if (words !== key.toLowerCase()) phrases.push(words);
    }
  }
  return phrases.sort((a, b) => b.length - a.length);
}

function firstMention(segments: InstructionSegment[], pattern: RegExp): Mention | null {
  for (const [index, segment] of segments.entries()) {
    if (segment.t !== 'text') continue;
    const match = pattern.exec(segment.v);
    if (match && match.index !== undefined) {
      return { segment: index, start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

function overlaps(a: Mention, b: Mention): boolean {
  return a.segment === b.segment && a.start < b.end && b.start < a.end;
}

interface SegmentList {
  path: string;
  segments: InstructionSegment[];
  /** Names the list can chip and does not have to: everything except its always-known ones. */
  candidates: string[];
}

/**
 * Every prompt-bound segment list in the document with the variables it
 * could chip: results saved by steps that come before it, lists collected
 * by loops it is not inside, and the trigger's values. Not offered: the
 * node's own saveAs (its instruction naturally says what it finds), the
 * item var of a loop it sits in (sent to every body step regardless), and
 * the builtins (always sent). A terminal's message is not a prompt, so it
 * is not here.
 */
function segmentLists(nodes: AgentStepNode[], triggers: TriggerDraft[]): SegmentList[] {
  const walked = walkSteps(nodes);
  const triggerNames = triggerVariableNames(triggers).filter((name) => !isAlwaysKnown(name));
  const lists: SegmentList[] = [];

  for (const { node, path, ordinal } of walked) {
    const inside = (container: string) => path.startsWith(`${container}.`);
    const earlierSaves = walked.flatMap(({ node: other, ordinal: otherOrdinal }) =>
      otherOrdinal < ordinal && isActionStepNode(other) && other.saveAs ? [other.saveAs] : []
    );
    const finishedLists = walked.flatMap(
      ({ node: other, path: otherPath, ordinal: otherOrdinal }) =>
        other.kind === 'loop' && other.collectVar && otherOrdinal < ordinal && !inside(otherPath)
          ? [other.collectVar]
          : []
    );
    const enclosingItems = new Set(
      walked.flatMap(({ node: other, path: otherPath }) =>
        other.kind === 'loop' && other.mode === 'foreach' && inside(otherPath)
          ? [other.itemVar]
          : []
      )
    );
    const candidates = [...new Set([...earlierSaves, ...finishedLists, ...triggerNames])].filter(
      (name) => !enclosingItems.has(name)
    );

    switch (node.kind) {
      case 'branch':
        lists.push({ path: `${path}.condition`, segments: node.condition, candidates });
        break;
      case 'loop':
        if (node.mode === 'until') {
          lists.push({ path: `${path}.condition`, segments: node.condition, candidates });
        }
        break;
      case 'group':
      case 'terminal':
        break;
      case 'action':
      case undefined: {
        const own = candidates.filter((name) => name !== node.saveAs);
        lists.push({ path: `${path}.instruction`, segments: node.instruction, candidates: own });
        node.failureHandling.forEach((handling, index) => {
          if (!handling.guidance || handling.guidance.length === 0) return;
          lists.push({
            path: `${path}.failureHandling.${index}`,
            segments: handling.guidance,
            candidates: own,
          });
        });
        break;
      }
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return lists;
}

function unchippedNameHints(list: SegmentList): LintHint[] {
  const chipped = new Set(varSegments(list.segments));
  const hints: LintHint[] = [];
  for (const name of list.candidates) {
    if (chipped.has(name)) continue;
    for (const phrase of phrasesFor(name)) {
      const at = firstMention(list.segments, phrasePattern(phrase));
      if (!at) continue;
      if (hints.some((hint) => overlaps(hint.at, at))) break;
      hints.push({
        path: list.path,
        message: `This mentions “${phrase}” but does not chip [${name}] — the step will not be given it. Add the chip where the value is meant.`,
        variable: name,
        at,
      });
      break;
    }
  }
  return hints;
}

function triggerAllusionHint(
  list: SegmentList,
  triggers: TriggerDraft[],
  taken: LintHint[]
): LintHint | null {
  if (varSegments(list.segments).some((name) => name.startsWith('trigger.'))) return null;
  for (const trigger of triggers) {
    if (trigger.kind !== 'event') continue;
    const nouns = EVENT_NOUNS[trigger.eventId];
    const provides = triggerEventById(trigger.eventId)?.provides ?? [];
    if (!nouns || provides.length === 0) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${DETERMINERS}\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:${nouns.map(escape).join('|')})s?(?![\\p{L}\\p{N}_])`,
      'iu'
    );
    const at = firstMention(list.segments, pattern);
    if (!at || taken.some((hint) => overlaps(hint.at, at))) continue;
    const example = provides[0]?.name ?? 'trigger.…';
    return {
      path: list.path,
      message: `This talks about the ${nouns[0]} that started the run but chips none of its details — the step will not see it. Insert the trigger value it needs (e.g. [${example}]).`,
      at,
    };
  }
  return null;
}

/** Every hint for a draft, in document order. Empty is the common case. */
export function lintAgentDraft(draft: {
  steps: AgentStepsDoc;
  triggers: TriggerDraft[];
}): LintHint[] {
  const hints: LintHint[] = [];
  for (const list of segmentLists(draft.steps.steps, draft.triggers)) {
    const named = unchippedNameHints(list);
    hints.push(...named);
    const allusion = triggerAllusionHint(list, draft.triggers, named);
    if (allusion) hints.push(allusion);
  }
  return hints;
}

/**
 * The fix for a named-variable hint: the mentioned words become the chip.
 * Returns the list untouched when the mention no longer fits (the text
 * changed since the hint was computed), so a stale click cannot corrupt
 * the instruction.
 */
export function chipMention(
  segments: InstructionSegment[],
  at: Mention,
  variable: string
): InstructionSegment[] {
  const target = segments[at.segment];
  if (!target || target.t !== 'text' || at.start < 0 || at.end > target.v.length) return segments;
  if (at.start >= at.end) return segments;
  const before = target.v.slice(0, at.start);
  const after = target.v.slice(at.end);
  return [
    ...segments.slice(0, at.segment),
    ...(before ? [{ t: 'text' as const, v: before }] : []),
    { t: 'var' as const, name: variable },
    ...(after ? [{ t: 'text' as const, v: after }] : []),
    ...segments.slice(at.segment + 1),
  ];
}
