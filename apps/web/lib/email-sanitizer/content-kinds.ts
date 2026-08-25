/**
 * The content kinds a cleaner script may be pointed at, and how to read one
 * off an untrusted request body.
 *
 * Parsing lives here rather than in the route because two routes need it
 * (save and dry-run) and because the failure mode matters: an unrecognised
 * kind must never widen a script's reach. Anything unparseable falls back
 * to mail, which is where every script started.
 */

import type { CleanerScriptKind } from '@renkei/email-sanitizer';

export const CONTENT_KINDS: readonly { id: CleanerScriptKind; label: string; hint: string }[] = [
  { id: 'msg', label: 'Email', hint: 'Messages, after classification and the built-in cleaners.' },
  { id: 'evt', label: 'Calendar', hint: 'Meeting invites — where conferencing boilerplate lives.' },
  { id: 'task', label: 'Tasks', hint: 'To-do items from Microsoft To Do and Planner.' },
];

export function isContentKind(value: unknown): value is CleanerScriptKind {
  return value === 'msg' || value === 'evt' || value === 'task';
}

/**
 * The kinds a payload asked for, or mail alone.
 *
 * Empty and malformed both mean mail: a script that runs on nothing is a
 * disabled script, and the enabled flag already expresses that more
 * legibly than an empty array would.
 */
export function parseContentKinds(value: unknown): CleanerScriptKind[] {
  if (!Array.isArray(value)) return ['msg'];
  const kinds = value.filter(isContentKind);
  return kinds.length > 0 ? [...new Set(kinds)] : ['msg'];
}

export function describeKinds(kinds: readonly CleanerScriptKind[]): string {
  const labels = CONTENT_KINDS.filter((kind) => kinds.includes(kind.id)).map((kind) => kind.label);
  return labels.length > 0 ? labels.join(', ') : 'Email';
}
