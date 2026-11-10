/**
 * The library's dialogs for several files at once (artifact-bulk-dialogs.tsx):
 *
 *   - Add to a project: the project, how its chats use the files, which
 *     of them it does not hold yet, and which this dialog has added;
 *   - Delete: which files are the viewer's (removed for good) and which
 *     were shared with them (only leave their list), who loses each owned
 *     one, and which this dialog has already removed.
 *
 * The dialogs make the calls, one file at a time, and dispatch each
 * answer; what they decide from that — what the warning names, what the
 * confirm button says and sends, what a partial failure says — is here,
 * and tested in artifact-bulk-dialogs.model.test.ts. A file this dialog
 * has already added or removed is never sent again: after a partial
 * failure the button retries only what is left, even before the page
 * behind the dialog has caught up.
 */

import type { ArtifactImpact, LibraryItem } from '@/lib/chat/artifact-library';

type Item = Pick<LibraryItem, 'id' | 'filename' | 'via' | 'projects'>;

/** One file's answer: null when it went through. */
export interface Outcome {
  id: string;
  error: string | null;
}

const plural = (count: number) => (count === 1 ? 'file' : 'files');

/** "3 of 5 could not be removed: No such file", or null when nothing failed. */
function failureLine(outcomes: readonly Outcome[], verb: string): string | null {
  const failures = outcomes.filter((outcome) => outcome.error !== null);
  if (failures.length === 0) return null;
  return `${failures.length} of ${outcomes.length} could not be ${verb}: ${failures[0].error}`;
}

// ---- Add to a project ----------------------------------------------------

export interface BulkAddState {
  projectId: string;
  mode: 'always' | 'on_demand';
  /** "project:file" for each file this dialog has attached. */
  added: readonly string[];
  busy: boolean;
  error: string | null;
}

export type BulkAddAction =
  | { type: 'projectChosen'; projectId: string }
  | { type: 'modeChosen'; mode: 'always' | 'on_demand' }
  | { type: 'sent' }
  | { type: 'answered'; projectId: string; outcomes: Outcome[] };

/** The dialog starts on the first project, On demand. */
export function initialBulkAdd(projects: readonly { id: string }[]): BulkAddState {
  return {
    projectId: projects[0]?.id ?? '',
    mode: 'on_demand',
    added: [],
    busy: false,
    error: null,
  };
}

export function bulkAddReducer(state: BulkAddState, action: BulkAddAction): BulkAddState {
  switch (action.type) {
    case 'projectChosen':
      return { ...state, projectId: action.projectId };
    case 'modeChosen':
      return { ...state, mode: action.mode };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'answered':
      return {
        ...state,
        busy: false,
        added: [
          ...state.added,
          ...action.outcomes
            .filter((outcome) => outcome.error === null)
            .map((outcome) => `${action.projectId}:${outcome.id}`),
        ],
        error: failureLine(action.outcomes, 'added'),
      };
  }
}

export interface BulkAddView<I> {
  target: { id: string; name: string } | null;
  /** The files the project does not hold yet. */
  toAdd: I[];
  /** "2 will be added." or "1 already in Billing; 2 will be added." */
  summary: string;
  label: string;
  disabled: boolean;
}

export function bulkAddView<I extends Item>(
  state: BulkAddState,
  items: readonly I[],
  projects: readonly { id: string; name: string }[]
): BulkAddView<I> {
  const target = projects.find((project) => project.id === state.projectId) ?? null;
  const toAdd = items.filter(
    (item) =>
      !item.projects.some((project) => project.id === state.projectId) &&
      !state.added.includes(`${state.projectId}:${item.id}`)
  );
  return {
    target,
    toAdd,
    summary:
      toAdd.length === items.length
        ? `${toAdd.length} will be added.`
        : `${items.length - toAdd.length} already in ${target?.name ?? 'this project'}; ${toAdd.length} will be added.`,
    label: `Add ${toAdd.length}`,
    disabled: state.busy || !target || toAdd.length === 0,
  };
}

/** "Add 1 file to a project". */
export function bulkAddTitle(count: number): string {
  return `Add ${count} ${plural(count)} to a project`;
}

// ---- Delete --------------------------------------------------------------

export interface BulkDeleteState {
  /** By file id, for the owned files; null until every one has answered. */
  impacts: Readonly<Record<string, ArtifactImpact>> | null;
  /** Files this dialog has removed (or taken off the list). */
  removed: readonly string[];
  busy: boolean;
  error: string | null;
}

export type BulkDeleteAction =
  | { type: 'impactsLoaded'; impacts: Record<string, ArtifactImpact> }
  | { type: 'sent' }
  | { type: 'answered'; outcomes: Outcome[] };

export const initialBulkDelete: BulkDeleteState = {
  impacts: null,
  removed: [],
  busy: false,
  error: null,
};

export function bulkDeleteReducer(
  state: BulkDeleteState,
  action: BulkDeleteAction
): BulkDeleteState {
  switch (action.type) {
    case 'impactsLoaded':
      return { ...state, impacts: action.impacts };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'answered':
      return {
        ...state,
        busy: false,
        removed: [
          ...state.removed,
          ...action.outcomes
            .filter((outcome) => outcome.error === null)
            .map((outcome) => outcome.id),
        ],
        error: failureLine(action.outcomes, 'removed'),
      };
  }
}

/** The viewer's own files (deleted for good) and the ones shared with them (only leave the list). */
export function splitByOwner<I extends Item>(items: readonly I[]): { owned: I[]; left: I[] } {
  return {
    owned: items.filter((item) => item.via === 'owner'),
    left: items.filter((item) => item.via !== 'owner'),
  };
}

/** The owned files someone else uses, each with who: "schema.md: Billing, Priya". */
export function deleteWarnings(
  items: readonly Item[],
  impacts: BulkDeleteState['impacts']
): { id: string; line: string }[] {
  return splitByOwner(items).owned.flatMap((item) => {
    const impact = impacts?.[item.id];
    if (!impact || (impact.projects.length === 0 && impact.sharedWith.length === 0)) return [];
    const users = [
      ...impact.projects.map((project) => project.name),
      ...impact.sharedWith.map((person) => person.name ?? person.email ?? '…'),
    ];
    return [{ id: item.id, line: `${item.filename}: ${users.join(', ')}` }];
  });
}

/** What the dialog says will happen to each kind of file. */
export function deleteSummary(items: readonly Item[]): string {
  const { owned, left } = splitByOwner(items);
  const parts: string[] = [];
  if (owned.length > 0) {
    parts.push(
      `${owned.length} ${owned.length === 1 ? 'file is' : 'files are'} yours and will be removed for good.`
    );
  }
  if (left.length > 0) {
    parts.push(
      `${left.length} shared with you ${left.length === 1 ? 'leaves' : 'leave'} your list; the owner keeps ${left.length === 1 ? 'it' : 'them'}.`
    );
  }
  return parts.join(' ');
}

export interface BulkDeleteView {
  /** Still working out who uses the owned files. */
  loading: boolean;
  /** The files Delete sends: none this dialog has already removed. */
  toRemove: string[];
  label: string;
  disabled: boolean;
}

export function bulkDeleteView(state: BulkDeleteState, items: readonly Item[]): BulkDeleteView {
  const loading = splitByOwner(items).owned.length > 0 && state.impacts === null;
  const toRemove = items.map((item) => item.id).filter((id) => !state.removed.includes(id));
  return {
    loading,
    toRemove,
    label: `Delete ${toRemove.length}`,
    disabled: state.busy || loading || toRemove.length === 0,
  };
}

/** "Delete 2 files?". */
export function bulkDeleteTitle(count: number): string {
  return `Delete ${count} ${plural(count)}?`;
}
