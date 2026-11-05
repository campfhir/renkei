/**
 * The "Move to project" dialog (move-chat-dialog.tsx), opened from a chat
 * row's ⋯ menu in the sidebar and from the open chat's own ⋯ menu: the
 * chat projects to choose from (handed in, or loaded when the dialog
 * opens), "No project" to take the chat back out, the one move in flight,
 * and why the server refused one. Tested in move-chat-dialog.model.test.ts.
 */

import type { ProjectListItem } from '@/lib/chat/sidebar';

export interface MoveChatState {
  /** Null while they load. */
  projects: ProjectListItem[] | null;
  /** Where the chat is going while the move is in flight; undefined when none is. */
  moving: string | null | undefined;
  error: string | null;
}

export function initialMoveChat(projects: ProjectListItem[] | null): MoveChatState {
  return { projects, moving: undefined, error: null };
}

export type MoveChatAction =
  | { type: 'projectsLoaded'; projects: ProjectListItem[] }
  | { type: 'projectsFailed'; error: string }
  /** `projectId` null: out of any project. */
  | { type: 'moveStarted'; projectId: string | null }
  | { type: 'moveFailed'; error: string }
  | { type: 'moved' };

export function moveChatReducer(state: MoveChatState, action: MoveChatAction): MoveChatState {
  switch (action.type) {
    case 'projectsLoaded':
      return { ...state, projects: action.projects };
    case 'projectsFailed':
      return { ...state, projects: [], error: action.error };
    case 'moveStarted':
      // One move at a time: a second press while one is in flight sends nothing.
      if (state.moving !== undefined) return state;
      return { ...state, moving: action.projectId, error: null };
    case 'moveFailed':
      return { ...state, moving: undefined, error: action.error };
    case 'moved':
      return { ...state, moving: undefined, error: null };
  }
}

export interface MoveTarget {
  projectId: string | null;
  label: string;
  /** Where the chat already is: shown, not offered. */
  current: boolean;
  disabled: boolean;
}

/** "No project" first, then each chat project, the chat's own marked current. */
export function moveTargets(state: MoveChatState, currentProjectId: string | null): MoveTarget[] {
  const busy = state.moving !== undefined;
  const target = (projectId: string | null, label: string): MoveTarget => {
    const current = projectId === currentProjectId;
    return { projectId, label, current, disabled: busy || current };
  };
  return [
    target(null, 'No project'),
    ...(state.projects ?? []).map((project) => target(project.id, project.name)),
  ];
}

/** What the dialog says under its list, when the list itself says nothing. */
export function moveEmptyNote(state: MoveChatState): string | null {
  if (state.projects === null) return 'Loading projects…';
  return state.projects.length === 0 && !state.error
    ? 'You have no projects yet. Create one under Projects, then move the chat into it.'
    : null;
}
