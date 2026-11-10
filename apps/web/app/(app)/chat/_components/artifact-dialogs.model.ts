/**
 * The one-file dialogs of the artifacts library (artifact-dialogs.tsx):
 *
 *   - Delete: the impact as the server worked it out, hand-over or
 *     deletion, the new owner, and what is in flight;
 *   - Copy: the copy's name and the project it goes to;
 *   - Rename: the new name.
 *
 * The dialogs make the calls and dispatch what the person did and what
 * the server answered; what they decide from that — which choice starts
 * checked, what the confirm button says and whether it is on, what each
 * one sends, what a refusal leaves — is here, and tested in
 * artifact-dialogs.model.test.ts.
 */

import type { ArtifactImpact } from '@/lib/chat/artifact-library';
import { personName, type Person } from './share-modal.model';

/** What a delete dialog works from when the impact could not be read. */
export const NO_IMPACT: ArtifactImpact = { projects: [], sharedWith: [], chat: null };

// ---- Delete --------------------------------------------------------------

export interface DeleteState {
  /** null until the server has said who uses it. */
  impact: ArtifactImpact | null;
  choice: 'transfer' | 'delete';
  newOwner: Person | null;
  busy: boolean;
  error: string | null;
}

export type DeleteAction =
  | { type: 'impactLoaded'; impact: ArtifactImpact | null; error: string | null }
  | { type: 'choiceChanged'; choice: 'transfer' | 'delete' }
  | { type: 'ownerChosen'; person: Person | null }
  | { type: 'sent' }
  | { type: 'failed'; error: string }
  | { type: 'done' };

export const initialDelete: DeleteState = {
  impact: null,
  choice: 'delete',
  newOwner: null,
  busy: false,
  error: null,
};

/** Whether anyone else reads the file: a project holds it, or it is shared. */
export function othersUse(impact: ArtifactImpact | null): boolean {
  return impact ? impact.projects.length > 0 || impact.sharedWith.length > 0 : false;
}

export function deleteReducer(state: DeleteState, action: DeleteAction): DeleteState {
  switch (action.type) {
    case 'impactLoaded': {
      const impact = action.impact ?? NO_IMPACT;
      return {
        ...state,
        impact,
        error: action.error ?? state.error,
        // When anyone else uses it, handing it over is where the dialog starts.
        choice: othersUse(impact) ? 'transfer' : state.choice,
      };
    }
    case 'choiceChanged':
      return { ...state, choice: action.choice };
    case 'ownerChosen':
      return { ...state, newOwner: action.person };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'done':
      return { ...state, busy: false };
  }
}

/** What the confirm button sends: a hand-over to the chosen person, or the delete. */
export function deleteRequest(
  state: DeleteState
): { kind: 'transfer'; newOwnerSubject: string } | { kind: 'delete' } {
  return state.choice === 'transfer' && state.newOwner
    ? { kind: 'transfer', newOwnerSubject: state.newOwner.subject }
    : { kind: 'delete' };
}

/** The confirm button: off while the impact loads, while a hand-over has nobody, or in flight. */
export function deleteFooter(state: DeleteState): {
  disabled: boolean;
  label: string;
  danger: boolean;
} {
  const others = othersUse(state.impact);
  const handOver = state.choice === 'transfer' && others;
  return {
    disabled:
      state.busy || state.impact === null || (state.choice === 'transfer' && !state.newOwner),
    label: handOver
      ? `Hand over${state.newOwner ? ` to ${personName(state.newOwner)}` : ''}`
      : 'Delete',
    danger: state.choice === 'delete' || !others,
  };
}

/** A project in the impact list: "Billing · 3 members · kept in context". */
export function impactProjectLine(project: ArtifactImpact['projects'][number]): string {
  return `${project.name} · ${project.members} ${project.members === 1 ? 'member' : 'members'}${
    project.mode === 'always' ? ' · kept in context' : ''
  }`;
}

/** "Shared with Priya, sam@example.test". */
export function sharedWithLine(impact: ArtifactImpact): string | null {
  if (impact.sharedWith.length === 0) return null;
  return `Shared with ${impact.sharedWith.map((person) => person.name ?? person.email ?? '…').join(', ')}`;
}

/** The line shown when nobody else uses it. */
export function aloneLine(impact: ArtifactImpact): string {
  return `Nobody else uses this file${impact.chat ? ' beyond the chat it came from' : ''}. It is removed for good.`;
}

// ---- Copy ----------------------------------------------------------------

/** "report (copy).pdf": the copy's name before the person changes it. */
export function defaultCopyName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)} (copy)${filename.slice(dot)}` : `${filename} (copy)`;
}

export interface CopyState {
  filename: string;
  /** Empty for "Nowhere yet". */
  attachProjectId: string;
  busy: boolean;
  error: string | null;
}

export type CopyAction =
  | { type: 'named'; filename: string }
  | { type: 'projectChosen'; projectId: string }
  | { type: 'sent' }
  | { type: 'failed'; error: string | null }
  | { type: 'done' };

export function initialCopy(filename: string): CopyState {
  return { filename: defaultCopyName(filename), attachProjectId: '', busy: false, error: null };
}

export function copyReducer(state: CopyState, action: CopyAction): CopyState {
  switch (action.type) {
    case 'named':
      return { ...state, filename: action.filename };
    case 'projectChosen':
      return { ...state, attachProjectId: action.projectId };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'failed':
      return { ...state, busy: false, error: action.error ?? 'The copy could not be made.' };
    case 'done':
      return { ...state, busy: false };
  }
}

/** What Make a copy sends: a blank name leaves the server to name it. */
export function copyRequest(state: CopyState): {
  filename: string | undefined;
  attachProjectId: string | null;
} {
  return {
    filename: state.filename.trim() || undefined,
    attachProjectId: state.attachProjectId || null,
  };
}

// ---- Rename --------------------------------------------------------------

export interface RenameState {
  filename: string;
  busy: boolean;
  error: string | null;
}

export type RenameAction =
  | { type: 'named'; filename: string }
  | { type: 'sent' }
  | { type: 'failed'; error: string }
  | { type: 'done' };

export function initialRename(filename: string): RenameState {
  return { filename, busy: false, error: null };
}

export function renameReducer(state: RenameState, action: RenameAction): RenameState {
  switch (action.type) {
    case 'named':
      return { ...state, filename: action.filename };
    case 'sent':
      return { ...state, busy: true };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'done':
      return { ...state, busy: false };
  }
}

/** The name Rename sends: as typed, without the spaces around it. */
export function renameRequest(state: RenameState): string {
  return state.filename.trim();
}
