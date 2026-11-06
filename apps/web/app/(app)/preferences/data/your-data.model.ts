/**
 * The Your data page's import (your-data.tsx): bringing
 * chats and memories in from another assistant. The person picks a file
 * (an export zip, one of its JSON files, Markdown or text) or pastes text;
 * Preview asks the server what it found, which shows counts and a few
 * examples; they choose memories, chats or both (and whether the chats go
 * to the archive); Import writes it and says what landed.
 *
 * What the page decides — when Preview and Import are allowed, what a
 * new file or new text does to a preview already shown, what each request
 * asks for, and the words for a preview, an outcome and a refusal — is
 * here, tested in your-data.model.test.ts. The downloads are
 * plain links (GET /api/account/export and …/profile) with nothing to
 * decide. The server parses and refuses on its own
 * (app/api/account/import, route.test.ts beside it).
 */

import { isString, recordOrNull } from '@renkei/guards';
import type { ImportOutcome, ImportPreview } from '@/lib/data-portability/types';

/** app/api/account/import's own cap (read-upload.ts), refused here before uploading. */
export const IMPORT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export type ImportInput = 'file' | 'paste';
export type ImportPhase = 'idle' | 'previewing' | 'previewed' | 'importing' | 'imported' | 'failed';

export interface YourDataState {
  input: ImportInput;
  file: { name: string; size: number } | null;
  pasted: string;
  phase: ImportPhase;
  preview: ImportPreview | null;
  outcome: ImportOutcome | null;
  /** Notes the server returned with an outcome (what the parser left out). */
  notes: string[];
  problem: string | null;
  memories: boolean;
  chats: boolean;
  archiveChats: boolean;
}

export type YourDataAction =
  | { type: 'inputChosen'; input: ImportInput }
  | { type: 'fileChosen'; name: string; size: number }
  | { type: 'fileCleared' }
  | { type: 'pasted'; text: string }
  | { type: 'previewSent' }
  | { type: 'previewed'; preview: ImportPreview }
  | { type: 'toggled'; option: 'memories' | 'chats' | 'archiveChats' }
  | { type: 'importSent' }
  | { type: 'imported'; outcome: ImportOutcome; notes: string[] }
  /** Refused by the server, or unreachable: the words to show. */
  | { type: 'failed'; problem: string }
  | { type: 'startedOver' };

export function initYourData(): YourDataState {
  return {
    input: 'file',
    file: null,
    pasted: '',
    phase: 'idle',
    preview: null,
    outcome: null,
    notes: [],
    problem: null,
    memories: true,
    chats: true,
    archiveChats: true,
  };
}

/** What is to be imported changed: whatever was found for the old one no longer holds. */
function changed(state: YourDataState): YourDataState {
  return { ...state, phase: 'idle', preview: null, outcome: null, notes: [], problem: null };
}

export function yourDataReducer(state: YourDataState, action: YourDataAction): YourDataState {
  switch (action.type) {
    case 'inputChosen':
      return action.input === state.input ? state : changed({ ...state, input: action.input });
    case 'fileChosen':
      return changed({ ...state, file: { name: action.name, size: action.size } });
    case 'fileCleared':
      return changed({ ...state, file: null });
    case 'pasted':
      return changed({ ...state, pasted: action.text });
    case 'previewSent':
      return { ...state, phase: 'previewing', problem: null, outcome: null };
    case 'previewed':
      return {
        ...state,
        phase: 'previewed',
        preview: action.preview,
        // Offer what was found, and only that.
        memories: action.preview.memories > 0,
        chats: action.preview.chats > 0,
      };
    case 'toggled':
      return { ...state, [action.option]: !state[action.option] };
    case 'importSent':
      return { ...state, phase: 'importing', problem: null };
    case 'imported':
      return { ...state, phase: 'imported', outcome: action.outcome, notes: action.notes };
    case 'failed':
      return { ...state, phase: 'failed', problem: action.problem };
    case 'startedOver':
      return { ...initYourData(), input: state.input };
  }
}

const busy = (state: YourDataState) => state.phase === 'previewing' || state.phase === 'importing';

/** Why the chosen file cannot be sent, or null. */
export function fileProblem(state: YourDataState): string | null {
  if (state.input !== 'file' || !state.file) return null;
  if (state.file.size === 0) return 'That file is empty.';
  if (state.file.size > IMPORT_MAX_FILE_BYTES) {
    return `That file is larger than ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

export function hasSomething(state: YourDataState): boolean {
  return state.input === 'file' ? state.file !== null : state.pasted.trim().length > 0;
}

export function canPreview(state: YourDataState): boolean {
  return !busy(state) && state.phase !== 'imported' && hasSomething(state) && !fileProblem(state);
}

export function canImport(state: YourDataState): boolean {
  const preview = state.preview;
  // After a refused import the preview stays, so it can be tried again.
  if ((state.phase !== 'previewed' && state.phase !== 'failed') || !preview) return false;
  return (state.memories && preview.memories > 0) || (state.chats && preview.chats > 0);
}

/** The name the upload goes under: the file's own, or pasted text as Markdown. */
function uploadName(state: YourDataState): string {
  return state.input === 'file' && state.file ? state.file.name : 'pasted.md';
}

/** The query string of the preview request (POST /api/account/import?…). */
export function previewQuery(state: YourDataState): string {
  return new URLSearchParams({ mode: 'preview', name: uploadName(state) }).toString();
}

/** The query string of the import request: only what is chosen and was found. */
export function importQuery(state: YourDataState): string {
  const params = new URLSearchParams({ mode: 'import', name: uploadName(state) });
  if (state.memories && (state.preview?.memories ?? 0) > 0) params.set('memories', '1');
  if (state.chats && (state.preview?.chats ?? 0) > 0) {
    params.set('chats', '1');
    if (state.archiveChats) params.set('archive', '1');
  }
  return params.toString();
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

function listed(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Found 12 memories and 3 chats (40 messages) from ChatGPT." */
export function previewWords(preview: ImportPreview): string {
  const found: string[] = [];
  if (preview.memories > 0) found.push(plural(preview.memories, 'memory', 'memories'));
  if (preview.chats > 0) {
    found.push(`${plural(preview.chats, 'chat')} (${plural(preview.messages, 'message')})`);
  }
  const from = preview.sources.length > 0 ? ` from ${listed(preview.sources)}` : '';
  return `Found ${listed(found)}${from}.`;
}

/** What an import wrote, and what it did not, in words. */
export function outcomeWords(outcome: ImportOutcome): string[] {
  const added: string[] = [];
  if (outcome.memoriesAdded > 0) added.push(plural(outcome.memoriesAdded, 'memory', 'memories'));
  if (outcome.chatsAdded > 0) added.push(plural(outcome.chatsAdded, 'chat'));
  const lines = [added.length > 0 ? `Imported ${listed(added)}.` : 'Nothing was imported.'];
  if (outcome.memoriesNoRoom > 0) {
    lines.push(
      `${plural(outcome.memoriesNoRoom, 'memory', 'memories')} did not fit: your memory is full. Forget some on the Memory page and import again.`
    );
  }
  if (outcome.stopped === 'memory-key' || outcome.stopped === 'chat-key') {
    lines.push(
      'The import stopped early: your encryption key was not available. Sign in again and retry.'
    );
  }
  return lines;
}

/** The words for a refused request, from its JSON body. */
export function refusalWords(body: unknown): string {
  const error = recordOrNull(body)?.error;
  return typeof error === 'string' && error ? error : 'Could not import that.';
}

export function previewLabel(state: YourDataState): string {
  return state.phase === 'previewing' ? 'Reading…' : 'Preview';
}

export function importLabel(state: YourDataState): string {
  return state.phase === 'importing' ? 'Importing…' : 'Import';
}

/** Whether the preview (and its choices) shows: once found, until an import lands. */
export function showsPreview(state: YourDataState): boolean {
  return state.preview !== null && state.phase !== 'imported';
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);

/** The preview in a 200 answer from the preview request, or null when it has none. */
export function previewFromAnswer(answer: unknown): ImportPreview | null {
  const preview = recordOrNull(recordOrNull(answer)?.preview);
  if (!preview) return null;
  return {
    sources: strings(preview.sources),
    memories: count(preview.memories),
    chats: count(preview.chats),
    messages: count(preview.messages),
    sampleMemories: strings(preview.sampleMemories),
    sampleChats: (Array.isArray(preview.sampleChats) ? preview.sampleChats : []).flatMap((item) => {
      const chat = recordOrNull(item);
      return chat && isString(chat.title)
        ? [{ title: chat.title, messages: count(chat.messages) }]
        : [];
    }),
    notes: strings(preview.notes),
  };
}

/** The outcome and notes in a 200 answer from the import request, or null when it has none. */
export function importedFromAnswer(
  answer: unknown
): { outcome: ImportOutcome; notes: string[] } | null {
  const body = recordOrNull(answer);
  const imported = recordOrNull(body?.imported);
  if (!body || !imported) return null;
  const stopped =
    imported.stopped === 'memory-key' || imported.stopped === 'chat-key' ? imported.stopped : null;
  return {
    outcome: {
      memoriesAdded: count(imported.memoriesAdded),
      memoriesNoRoom: count(imported.memoriesNoRoom),
      chatsAdded: count(imported.chatsAdded),
      messagesAdded: count(imported.messagesAdded),
      stopped,
    },
    notes: strings(body.notes),
  };
}
