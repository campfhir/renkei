/**
 * What a reply's Copy puts on the clipboard. Pure; the button lives in
 * message-list.tsx.
 *
 * By default only the prose: what most people copy a reply for is the
 * answer, not the work behind it. With `toolCalls` the calls the reply
 * made are copied too, in order between the prose, each as its name, its
 * input and its result in fences — so a person can paste the whole
 * exchange into a bug report or another chat. Thinking is never copied:
 * it is the model's scratch work, folded away on screen for that reason.
 */

import type { Segment, WorkStep } from './segment';

type Call = Extract<WorkStep, { kind: 'call' }>;

export interface CopyOptions {
  toolCalls?: boolean;
}

/** The reply's calls, in order, wherever segment() put them. */
export function replyCalls(segments: Segment[]): Call[] {
  const calls: Call[] = [];
  for (const part of segments) {
    if (part.kind === 'work') {
      for (const step of part.steps) if (step.kind === 'call') calls.push(step);
    } else if ('step' in part) {
      calls.push(part.step);
    }
  }
  return calls;
}

export function replyCopyText(segments: Segment[], options: CopyOptions = {}): string {
  const pieces: string[] = [];
  for (const part of segments) {
    if (part.kind === 'text') {
      const text = part.text.trim();
      if (text) pieces.push(text);
    } else if (options.toolCalls) {
      for (const call of replyCalls([part])) pieces.push(callText(call));
    }
  }
  return pieces.join('\n\n');
}

function callText({ block, result }: Call): string {
  const lines = [`Tool call: ${block.name}`, fence(inputText(block.input), 'json')];
  if (result) {
    lines.push(result.isError ? 'Error:' : 'Result:', fence(result.content, ''));
  } else {
    lines.push('No result.');
  }
  return lines.join('\n');
}

function inputText(input: unknown): string {
  if (input === undefined || input === null) return '{}';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** A fence one backtick longer than any run inside, so content can't close it early. */
function fence(text: string, lang: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}
