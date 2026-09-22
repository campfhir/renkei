/**
 * What a person does to the repository from the code pane — a file
 * saved, a commit, a push — written into the chat's transcript as a
 * **note row**: user-role, kind 'note', stored and shown like auto
 * mode's nudge rows (a small line in the thread, never the person's
 * bubble). One row does three things: the next turn's model reads it in
 * the conversation, so it knows a person changed those files by hand
 * rather than finding a surprise in git status; `chat-commits.ts` counts
 * a commit made here exactly like one the chat's tool made; and the
 * thread stays an honest log of what happened to the checkout.
 *
 * The text is written for the model and parsed back for the thread:
 * `noteText` renders one, `parseNote` reads one. A commit's first line
 * is the commit tool's own "Committed on <branch>: <sha> <subject>", so
 * the one parser serves both. Pure — the browser reads notes with it;
 * the write is notes.ts.
 */

import { parseCommitResult, parsePushResult } from './chat-commits';

export type ChatNote =
  | { type: 'edit'; paths: string[] }
  | { type: 'commit'; branch: string; sha: string; subject: string }
  | { type: 'push'; branch: string; remoteBranch: string };

const EDIT_PREFIX = 'Note from the editor: the person edited and saved by hand in the code pane: ';
const EDIT_SUFFIX =
  '\nThe changes are in the checkout, uncommitted. Read a file again before editing it.';
const COMMIT_SUFFIX =
  '\nNote from the editor: the person made this commit themselves from the code pane. It is not pushed yet.';
const PUSH_SUFFIX = '\nNote from the editor: the person pushed from the code pane.';

export const NOTE_MAX_PATHS = 200;

/** The note as the row stores it. */
export function noteText(note: ChatNote): string {
  switch (note.type) {
    case 'edit':
      return `${EDIT_PREFIX}${note.paths.join(', ')}.${EDIT_SUFFIX}`;
    case 'commit':
      return `Committed on ${note.branch}: ${note.sha} ${note.subject}`.trimEnd() + COMMIT_SUFFIX;
    case 'push':
      return `Pushed ${note.branch} to origin/${note.remoteBranch}.${PUSH_SUFFIX}`;
  }
}

/** The note a row's text describes, or null for text that is not one. */
export function parseNote(text: string): ChatNote | null {
  const first =
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';
  if (first.startsWith(EDIT_PREFIX)) {
    const list = first.slice(EDIT_PREFIX.length).replace(/\.$/, '');
    const paths = list
      .split(', ')
      .map((path) => path.trim())
      .filter(Boolean);
    return paths.length ? { type: 'edit', paths } : null;
  }
  const commit = parseCommitResult(first);
  if (commit) return { type: 'commit', ...commit };
  const push = parsePushResult(first);
  if (push) return { type: 'push', ...push };
  return null;
}

/** A note as a request body names it, checked; null for anything else. */
export function noteFromInput(value: unknown): ChatNote | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const str = (key: string, max: number): string => {
    const field = raw[key];
    return typeof field === 'string' ? field.trim().slice(0, max) : '';
  };
  if (raw.type === 'edit') {
    if (!Array.isArray(raw.paths)) return null;
    const paths = raw.paths
      .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
      .map((path) => path.trim().slice(0, 1024))
      .slice(0, NOTE_MAX_PATHS);
    return paths.length ? { type: 'edit', paths } : null;
  }
  if (raw.type === 'commit') {
    const branch = str('branch', 200);
    const sha = str('sha', 40);
    const subject = str('subject', 500).split('\n')[0] ?? '';
    if (!branch || !/^[0-9a-f]{4,40}$/i.test(sha)) return null;
    return { type: 'commit', branch, sha, subject };
  }
  if (raw.type === 'push') {
    const branch = str('branch', 200);
    const remoteBranch = str('remoteBranch', 200);
    if (!branch || !remoteBranch) return null;
    return { type: 'push', branch, remoteBranch };
  }
  return null;
}
