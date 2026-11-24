/**
 * One variable set being edited (variables-editor.tsx): the repository's
 * variables, or one deployment environment's, as rows — a name, a value,
 * and a lock that makes it a secret. Rows come from the host, from typing
 * one at a time, from a `.env` file the person picks, and from the bulk
 * edit box — the set as `.env` text, where lines add and replace and a
 * commented line removes — all read here, in the browser: nothing leaves
 * until Save, and Save sends the change
 * straight to the project's variables route (never to a model).
 *
 * A secret's value is write-only: the host never sends one back, so a
 * secret row starts empty and a typed value replaces what the host has.
 * Tested in variables-editor.model.test.ts.
 */

import { parseDotenv } from '@renkei/connector-sandbox/dotenv';
import { looksLikeSecret } from '@/lib/code/pipeline-variable-plan';

/** A variable as the host lists it; a secret has no value to show. */
export interface ListedVariable {
  key: string;
  value: string | null;
  secured: boolean;
}

export interface Row {
  id: number;
  key: string;
  /** What is typed; empty on an untouched secret. */
  value: string;
  /** Locked: saved as a secret. */
  secured: boolean;
  /** As the host has it; null for a row that is not saved yet. */
  original: { value: string | null; secured: boolean } | null;
  /** Marked to be taken away by the next save. */
  removed: boolean;
}

/** What the last save did, as the route answered it. */
export interface Applied {
  added: string[];
  changed: string[];
  removed: string[];
  errors: string[];
  environmentCreated?: boolean;
}

export interface EditorState {
  rows: Row[];
  nextId: number;
  busy: boolean;
  /** The save the route refused whole. */
  error: string | null;
  /** What the last file or bulk edit brought, until the next edit. */
  imported: {
    source: string;
    added: number;
    updated: number;
    same: number;
    /** Variables a bulk edit's commented lines marked to go. */
    removed: number;
  } | null;
  /** Lines of the last file or bulk edit that were not variables. */
  problems: string[];
  outcome: Applied | null;
  /** The bulk edit box's text, when it is open. */
  paste: string | null;
  /** The row whose value takes the cursor (the builder's "Set it"). */
  focus: number | null;
}

export type EditorAction =
  | { type: 'loaded'; variables: ListedVariable[] }
  | { type: 'rowAdded' }
  | { type: 'rowChanged'; id: number; field: 'key' | 'value'; value: string }
  | { type: 'lockToggled'; id: number }
  /** A saved row is marked to go (or unmarked); a row not saved yet is dropped. */
  | { type: 'removeToggled'; id: number }
  /** A `.env` file's text, read in the browser. */
  | { type: 'fileRead'; name: string; text: string }
  /**
   * The bulk edit box: the set as `.env` text, to add to and change many at
   * once. It opens on the plain variables (a secret's value cannot be
   * shown, so secrets are not in it); applying it adds and replaces what
   * its lines name, and a commented line, `# NAME=…`, marks NAME to go.
   */
  | { type: 'pasteOpened' }
  | { type: 'pasteChanged'; text: string }
  | { type: 'pasteCancelled' }
  | { type: 'pasteApplied' }
  /** The page was sent to set one variable. */
  | { type: 'asked'; name: string; secured: boolean }
  | { type: 'discarded' }
  | { type: 'sent' }
  | { type: 'failed'; error: string }
  /** The save went through; `variables` is the set as the host has it now. */
  | { type: 'saved'; outcome: Applied; variables: ListedVariable[] };

export const initialEditor: EditorState = {
  rows: [],
  nextId: 1,
  busy: false,
  error: null,
  imported: null,
  problems: [],
  outcome: null,
  paste: null,
  focus: null,
};

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A `.env` larger than this is not one. */
export const MAX_FILE_BYTES = 256 * 1024;

function rowsOf(variables: readonly ListedVariable[], firstId: number): Row[] {
  return variables.map((variable, index) => ({
    id: firstId + index,
    key: variable.key,
    value: variable.secured ? '' : (variable.value ?? ''),
    secured: variable.secured,
    original: {
      value: variable.secured ? null : (variable.value ?? ''),
      secured: variable.secured,
    },
    removed: false,
  }));
}

function loaded(state: EditorState, variables: readonly ListedVariable[]): EditorState {
  return {
    ...state,
    rows: rowsOf(variables, state.nextId),
    nextId: state.nextId + variables.length,
  };
}

/** A value as a `.env` line's right-hand side: bare when it can be, double-quoted otherwise. */
function envValue(value: string): string {
  if (value === '' || /^[^\s"'#\\]+$/.test(value)) return value;
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * What the bulk edit box opens on: the plain variables as they stand on
 * screen, one `NAME=value` a line. Secrets are left out — their values
 * cannot be shown — and so are rows already marked to go.
 */
export function bulkText(state: Pick<EditorState, 'rows'>): string {
  return state.rows
    .filter((row) => !row.secured && !row.removed && KEY.test(row.key.trim()))
    .map((row) => `${row.key.trim()}=${envValue(row.value)}`)
    .join('\n');
}

/** A commented-out variable line, `# NAME=…`, with any space around the `#`. */
const COMMENTED = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** The names a bulk edit's commented lines name, in order, once each. */
export function commentedNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const name = COMMENTED.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The rows with a `.env`'s variables merged in: a name already there takes
 * the value, a new one is a new row; nothing is taken away for not being
 * named. A bulk edit (`removals`) also reads its commented lines: `# NAME=…`
 * marks the saved variable NAME to go — unless a live line sets it too — and
 * is an ordinary comment when there is no such variable.
 */
function imported(
  state: EditorState,
  source: string,
  text: string,
  options: { removals?: boolean } = {}
): EditorState {
  const parsed = parseDotenv(text);
  let { rows, nextId } = state;
  let added = 0;
  let updated = 0;
  let same = 0;
  let removed = 0;
  const problems = [...parsed.problems];
  for (const [key, value] of Object.entries(parsed.values)) {
    if (!KEY.test(key)) {
      problems.push(`${key} is not a variable name`);
      continue;
    }
    const at = rows.findIndex((row) => row.key === key);
    if (at < 0) {
      rows = [
        ...rows,
        // A name that reads as a secret starts locked; the person can unlock it before saving.
        { id: nextId, key, value, secured: looksLikeSecret(key), original: null, removed: false },
      ];
      nextId += 1;
      added += 1;
      continue;
    }
    const row = rows[at]!;
    if (!row.removed && !row.secured && row.value === value) {
      same += 1;
      continue;
    }
    rows = rows.map((r, i) => (i === at ? { ...r, value, removed: false } : r));
    updated += 1;
  }
  if (options.removals) {
    for (const name of commentedNames(text)) {
      if (name in parsed.values) continue;
      const at = rows.findIndex((row) => row.key === name);
      const row = at < 0 ? undefined : rows[at];
      if (!row || row.removed) continue;
      // A saved variable is marked to go; one not saved yet is just dropped.
      rows = row.original
        ? rows.map((r, i) => (i === at ? { ...r, removed: true } : r))
        : rows.filter((_, i) => i !== at);
      removed += 1;
    }
  }
  return {
    ...state,
    rows,
    nextId,
    imported: { source, added, updated, same, removed },
    problems,
    outcome: null,
    error: null,
    paste: null,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const edited = (rows: Row[]): EditorState => ({
    ...state,
    rows,
    imported: null,
    problems: [],
    outcome: null,
    error: null,
    focus: null,
  });
  switch (action.type) {
    case 'loaded':
      // A read that lands on unsaved edits does not take them away.
      return isDirty(state) ? state : loaded(state, action.variables);
    case 'rowAdded':
      return {
        ...edited([
          ...state.rows,
          { id: state.nextId, key: '', value: '', secured: false, original: null, removed: false },
        ]),
        nextId: state.nextId + 1,
      };
    case 'rowChanged':
      return edited(
        state.rows.map((row) => {
          if (row.id !== action.id) return row;
          // A saved variable keeps its name: renaming is a removal and a new one.
          if (action.field === 'key') return row.original ? row : { ...row, key: action.value };
          return { ...row, value: action.value };
        })
      );
    case 'lockToggled':
      return edited(
        state.rows.map((row) => (row.id === action.id ? { ...row, secured: !row.secured } : row))
      );
    case 'removeToggled':
      return edited(
        state.rows.flatMap((row) => {
          if (row.id !== action.id) return [row];
          return row.original ? [{ ...row, removed: !row.removed }] : [];
        })
      );
    case 'fileRead':
      return imported(state, action.name, action.text);
    case 'pasteOpened':
      return { ...state, paste: bulkText(state) };
    case 'pasteChanged':
      return state.paste === null ? state : { ...state, paste: action.text };
    case 'pasteCancelled':
      return { ...state, paste: null };
    case 'pasteApplied':
      return state.paste?.trim()
        ? imported(state, 'the bulk edit', state.paste, { removals: true })
        : state;
    case 'asked': {
      const existing = state.rows.find((row) => row.key === action.name);
      if (existing) {
        return {
          ...state,
          rows: state.rows.map((row) => (row === existing ? { ...row, removed: false } : row)),
          focus: existing.id,
        };
      }
      return {
        ...state,
        rows: [
          ...state.rows,
          {
            id: state.nextId,
            key: action.name,
            value: '',
            secured: action.secured,
            original: null,
            removed: false,
          },
        ],
        nextId: state.nextId + 1,
        focus: state.nextId,
      };
    }
    case 'discarded':
      return {
        ...state,
        rows: state.rows
          .filter((row) => row.original)
          .map((row) => ({
            ...row,
            value: row.original!.secured ? '' : (row.original!.value ?? ''),
            secured: row.original!.secured,
            removed: false,
          })),
        imported: null,
        problems: [],
        error: null,
        paste: null,
        focus: null,
      };
    case 'sent':
      return { ...state, busy: true, error: null, outcome: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'saved': {
      // What the host refused stays on screen as typed, to be fixed and saved again.
      const refused = new Set(action.outcome.errors.map((error) => error.split(':')[0]!.trim()));
      const kept = state.rows.filter(
        (row) => refused.has(row.key) && rowState(row) !== 'same' && !row.original
      );
      const fresh = loaded({ ...state, rows: [] }, action.variables);
      return {
        ...fresh,
        rows: [
          ...fresh.rows.map((row) => {
            const typed = state.rows.find((r) => r.key === row.key && refused.has(r.key));
            return typed ? { ...row, value: typed.value, secured: typed.secured } : row;
          }),
          ...kept,
        ],
        busy: false,
        error: null,
        imported: null,
        problems: [],
        paste: null,
        focus: null,
        outcome: action.outcome,
      };
    }
  }
}

// ——— what the editor derives ———

export type RowState = 'same' | 'new' | 'changed' | 'removed';

/** How a row differs from what the host has. */
export function rowState(row: Row): RowState {
  if (!row.original) return 'new';
  if (row.removed) return 'removed';
  if (row.secured !== row.original.secured) return 'changed';
  if (row.secured) return row.value === '' ? 'same' : 'changed';
  return row.value === row.original.value ? 'same' : 'changed';
}

/** Why a row cannot be saved as it stands; null when it can. */
export function rowProblem(row: Row, rows: readonly Row[]): string | null {
  if (row.removed) return null;
  if (!row.original) {
    if (!row.key.trim()) return row.value ? 'Give it a name.' : null;
    if (!KEY.test(row.key.trim())) {
      return 'Letters, digits and underscores, not starting with a digit.';
    }
    if (rows.some((other) => other !== row && other.key === row.key.trim())) {
      return `${row.key.trim()} is here twice.`;
    }
    if (row.secured && row.value === '') return 'A secret needs a value.';
    return null;
  }
  if (row.original.secured && !row.secured && row.value === '') {
    return 'Its value cannot be read back: type it to make it plain.';
  }
  return null;
}

/** A row with neither a name nor a value: left alone by Save. */
const isBlank = (row: Row) => !row.original && !row.key.trim() && row.value === '';

export function isDirty(state: Pick<EditorState, 'rows'>): boolean {
  return state.rows.some((row) => !isBlank(row) && rowState(row) !== 'same');
}

export interface Changes {
  set: { key: string; value: string; secured: boolean }[];
  remove: string[];
}

/** What Save sends: the rows that differ, and the names marked to go. */
export function changes(state: Pick<EditorState, 'rows'>): Changes {
  const set: Changes['set'] = [];
  const remove: string[] = [];
  for (const row of state.rows) {
    if (isBlank(row)) continue;
    const kind = rowState(row);
    if (kind === 'removed') remove.push(row.key);
    else if (kind !== 'same') {
      set.push({ key: row.key.trim(), value: row.value, secured: row.secured });
    }
  }
  return { set, remove };
}

/** The body of the save: which set, and the change. */
export function saveRequest(
  state: Pick<EditorState, 'rows'>,
  /** The project's environment whose set this is; null for the repository's. */
  environment: string | null
): Changes & { scope: 'repository' | 'environment'; environment?: string } {
  return {
    scope: environment ? 'environment' : 'repository',
    ...(environment ? { environment } : {}),
    ...changes(state),
  };
}

export function canSave(state: EditorState): boolean {
  return (
    !state.busy && isDirty(state) && state.rows.every((row) => rowProblem(row, state.rows) === null)
  );
}

/** "2 to add · 1 to change · 1 to remove", or null when nothing differs. */
export function changeSummary(state: Pick<EditorState, 'rows'>): string | null {
  const rows = state.rows.filter((row) => !isBlank(row));
  const count = (kind: RowState) => rows.filter((row) => rowState(row) === kind).length;
  const parts = [
    count('new') ? `${count('new')} to add` : '',
    count('changed') ? `${count('changed')} to change` : '',
    count('removed') ? `${count('removed')} to remove` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The line after a file or bulk edit was read. */
export function importedLine(state: Pick<EditorState, 'imported'>): string | null {
  const read = state.imported;
  if (!read) return null;
  const total = read.added + read.updated + read.same;
  if (total === 0 && read.removed === 0) return `No variables were found in ${read.source}.`;
  const parts = [
    read.added ? `${read.added} new` : '',
    read.updated ? `${read.updated} changed` : '',
    read.same ? `${read.same} already as saved` : '',
    read.removed ? `${read.removed} to remove` : '',
  ].filter(Boolean);
  const named = total + read.removed;
  return `Read ${named} variable${named === 1 ? '' : 's'} from ${read.source}: ${parts.join(', ')}. Lock the ones that are secrets, then save.`;
}

/** The lines under a saved set. */
export function outcomeLines(outcome: Applied): { status: string | null; refused: string | null } {
  const parts = [
    outcome.added.length ? `added ${outcome.added.join(', ')}` : '',
    outcome.changed.length ? `changed ${outcome.changed.join(', ')}` : '',
    outcome.removed.length ? `removed ${outcome.removed.join(', ')}` : '',
  ].filter(Boolean);
  return {
    status: parts.length
      ? `Saved: ${parts.join(' · ')}.`
      : outcome.errors.length === 0
        ? 'Nothing changed.'
        : null,
    refused: outcome.errors.length ? `Not saved: ${outcome.errors.join('; ')}` : null,
  };
}

/** The value box's placeholder: a saved secret says its value is kept until replaced. */
export function valuePlaceholder(row: Row): string {
  if (row.original?.secured && row.secured) return 'Secret — type to replace';
  if (row.original?.secured) return 'Type its value to make it plain';
  return row.secured ? 'Secret value' : 'Value';
}

/** The question before a save that takes variables away; null when none goes. */
export function removalQuestion(state: Pick<EditorState, 'rows'>): string | null {
  const going = changes(state).remove;
  if (going.length === 0) return null;
  return `Remove ${going.join(', ')}? Pipeline runs will no longer see ${going.length === 1 ? 'it' : 'them'}.`;
}

/** Why a picked file is not read; null when it is. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is too large to be an environment file (over 256 KB).`;
  }
  return null;
}
