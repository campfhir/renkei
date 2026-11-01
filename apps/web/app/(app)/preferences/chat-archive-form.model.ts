/**
 * The "Archive old chats" preference (chat-archive-form.tsx): the days as
 * typed, the days as last saved, and where a save stands. What the form
 * decides — what an entry means (empty is never), what it refuses before
 * it leaves the page (not a whole number, longer than the organization
 * keeps chats), when Save is allowed, what it sends, and what a refusal
 * leaves on screen — is here, and tested in chat-archive-form.model.test.ts.
 * The server refuses the same over-long window on its own
 * (app/api/preferences, route.test.ts beside it).
 */

import { recordOrNull } from '@renkei/guards';

export type ArchiveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface ChatArchiveState {
  input: string;
  /** The entry as last saved, trimmed: Save is off while the field says the same. */
  saved: string;
  status: ArchiveStatus;
  problem: string | null;
}

export type ChatArchiveAction =
  | { type: 'typed'; input: string }
  | { type: 'sent' }
  | { type: 'stored' }
  /** Refused before sending, by the server, or unreachable: the words to show. */
  | { type: 'failed'; problem: string };

export function initChatArchive(afterDays: number | null): ChatArchiveState {
  const input = afterDays === null ? '' : String(afterDays);
  return { input, saved: input, status: 'idle', problem: null };
}

/** The days to save (null for never), or the words saying why the entry cannot be saved. */
export function parseArchiveDays(
  input: string,
  maxDays: number
): { days: number | null } | { error: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { days: null };
  const days = Number(trimmed);
  if (!Number.isInteger(days) || days < 1) {
    return { error: 'Enter a whole number of days, or leave it empty to never archive.' };
  }
  if (days > maxDays) {
    return { error: `Enter ${maxDays} days or fewer.` };
  }
  return { days };
}

export function chatArchiveReducer(
  state: ChatArchiveState,
  action: ChatArchiveAction
): ChatArchiveState {
  switch (action.type) {
    case 'typed':
      return { ...state, input: action.input, problem: null, status: 'idle' };
    case 'sent':
      return { ...state, problem: null, status: 'saving' };
    case 'stored':
      return { ...state, saved: state.input.trim(), status: 'saved' };
    case 'failed':
      return { ...state, problem: action.problem, status: 'failed' };
  }
}

export function canSave(state: ChatArchiveState): boolean {
  return state.status !== 'saving' && state.input.trim() !== state.saved;
}

export function saveLabel(state: ChatArchiveState): string {
  return state.status === 'saving' ? 'Saving…' : 'Save';
}

/** What Save sends to PUT /api/preferences. */
export function archiveRequest(days: number | null): { chatArchive: { afterDays: number | null } } {
  return { chatArchive: { afterDays: days } };
}

/** The server's refusal words, or a plain "Could not save." */
export function refusalWords(body: unknown): string {
  const message = recordOrNull(body)?.error;
  return typeof message === 'string' ? message : 'Could not save.';
}

/** The note under the field: the organization's ceiling, or what empty means. */
export function retentionNote(retentionDays: number): string {
  return retentionDays > 0
    ? `Your organization keeps chats for ${retentionDays} days, so this can be at most ${retentionDays}. Chats are deleted after that, whatever this is set to.`
    : 'Leave it empty to keep every chat in the list until you archive it yourself.';
}
