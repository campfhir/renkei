/**
 * The Knowledge panel's state (knowledge-panel.tsx): the notes as last
 * loaded, the one draft form (create or edit), the selection for deleting
 * several at once, the armed "Clear knowledge", and what is in flight.
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; everything the panel decides from that — what
 * the select-all box shows, whether Save is allowed, what a delete sends,
 * what a delete does to an open draft — is here, and tested in
 * knowledge-panel.model.test.ts.
 */

export interface NoteRow {
  noteId: string;
  title: string;
  content: string;
  authoredBy: 'user' | 'agent';
  sourceAt: string | null;
}

export interface Draft {
  /** null for a new note. */
  noteId: string | null;
  title: string;
  content: string;
}

export interface KnowledgeState {
  /** null until the first load answers: "No notes yet." must not flash before then. */
  notes: NoteRow[] | null;
  draft: Draft | null;
  busy: boolean;
  error: string | null;
  selected: ReadonlySet<string>;
  purgeArmed: boolean;
}

/** What a delete removes: some notes, or every one. */
export type Removal = { noteIds: string[] } | { all: true };

export type KnowledgeAction =
  | { type: 'loaded'; notes: NoteRow[] }
  | { type: 'loadFailed'; error: string }
  | { type: 'newNote' }
  | { type: 'edit'; note: NoteRow }
  | { type: 'draftChanged'; field: 'title' | 'content'; value: string }
  | { type: 'draftCancelled' }
  | { type: 'toggle'; noteId: string }
  | { type: 'toggleAll' }
  | { type: 'armPurge' }
  | { type: 'disarmPurge' }
  /** A save or delete went out. */
  | { type: 'sent' }
  | { type: 'saved' }
  | { type: 'removed'; removal: Removal }
  /** A save or delete was refused; what it changed stays as it was. */
  | { type: 'failed'; error: string };

export const initialKnowledge: KnowledgeState = {
  notes: null,
  draft: null,
  busy: false,
  error: null,
  selected: new Set(),
  purgeArmed: false,
};

function removes(removal: Removal, noteId: string): boolean {
  return 'all' in removal || removal.noteIds.includes(noteId);
}

export function knowledgeReducer(state: KnowledgeState, action: KnowledgeAction): KnowledgeState {
  switch (action.type) {
    case 'loaded': {
      // A selection only ever names notes that are still there.
      const present = new Set(action.notes.map((note) => note.noteId));
      const selected = new Set([...state.selected].filter((id) => present.has(id)));
      return { ...state, notes: action.notes, error: null, selected };
    }
    case 'loadFailed':
      return { ...state, error: action.error };
    case 'newNote':
      return { ...state, draft: { noteId: null, title: '', content: '' } };
    case 'edit':
      return {
        ...state,
        draft: {
          noteId: action.note.noteId,
          title: action.note.title,
          content: action.note.content,
        },
      };
    case 'draftChanged':
      if (!state.draft) return state;
      return { ...state, draft: { ...state.draft, [action.field]: action.value } };
    case 'draftCancelled':
      return { ...state, draft: null };
    case 'toggle': {
      const selected = new Set(state.selected);
      if (selected.has(action.noteId)) selected.delete(action.noteId);
      else selected.add(action.noteId);
      return { ...state, selected };
    }
    case 'toggleAll': {
      const notes = state.notes ?? [];
      const all = notes.length > 0 && state.selected.size === notes.length;
      return { ...state, selected: all ? new Set() : new Set(notes.map((note) => note.noteId)) };
    }
    case 'armPurge':
      return { ...state, purgeArmed: true };
    case 'disarmPurge':
      return { ...state, purgeArmed: false };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'saved':
      return { ...state, busy: false, draft: null };
    case 'removed': {
      const { removal } = action;
      // A draft editing something just deleted would save it back.
      const draftGone = state.draft?.noteId != null && removes(removal, state.draft.noteId);
      return {
        ...state,
        busy: false,
        purgeArmed: false,
        draft: draftGone ? null : state.draft,
        selected: new Set([...state.selected].filter((id) => !removes(removal, id))),
      };
    }
    case 'failed':
      return { ...state, busy: false, purgeArmed: false, error: action.error };
  }
}

/** The select-all box: checked, part-checked, and its words. */
export function selectAllBox(state: KnowledgeState): {
  checked: boolean;
  indeterminate: boolean;
  label: string;
} {
  const total = state.notes?.length ?? 0;
  const count = state.selected.size;
  return {
    checked: total > 0 && count === total,
    indeterminate: count > 0 && count < total,
    label: count > 0 ? `${count} selected` : 'Select all',
  };
}

/** Whether the draft may be saved: both fields say something, and nothing is in flight. */
export function canSave(state: KnowledgeState): boolean {
  return (
    !state.busy &&
    state.draft !== null &&
    !!state.draft.title.trim() &&
    !!state.draft.content.trim()
  );
}

/** The request Save sends, relative to the panel's route: a new note POSTs, an edit PUTs. */
export function saveRequest(draft: Draft): {
  method: 'POST' | 'PUT';
  path: string;
  body: { title: string; content: string };
} {
  const body = { title: draft.title, content: draft.content };
  return draft.noteId
    ? { method: 'PUT', path: `/${draft.noteId}`, body }
    : { method: 'POST', path: '', body };
}

/** The removal "Delete N" (the selection) or "Really delete all" sends. */
export function bulkRemoval(state: KnowledgeState, all: boolean): Removal {
  return all ? { all: true } : { noteIds: [...state.selected] };
}

/** A note's text as its row shows it: whole up to 300 characters, cut with an ellipsis past that. */
export function preview(content: string): string {
  return content.length > 300 ? `${content.slice(0, 299)}…` : content;
}
