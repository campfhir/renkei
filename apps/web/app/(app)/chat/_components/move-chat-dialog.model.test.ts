import type { ProjectListItem } from '@/lib/chat/sidebar';
import {
  initialMoveChat,
  moveChatReducer,
  moveEmptyNote,
  moveTargets,
  type MoveChatAction,
  type MoveChatState,
} from './move-chat-dialog.model';

const project = (id: string, name: string): ProjectListItem => ({
  id,
  name,
  ownerSubject: 'alice',
  ownerName: 'Alice',
  role: 'owner',
  updatedAt: '2026-11-01T00:00:00.000Z',
  repoFullName: null,
  description: null,
});
const HIRING = project('p-hiring', 'Hiring');
const BUDGET = project('p-budget', 'Budget');

const fold = (state: MoveChatState, ...actions: MoveChatAction[]) =>
  actions.reduce(moveChatReducer, state);

describe('the Move to project dialog', () => {
  it('offers every project to a chat in none, with No project marked where it is', () => {
    const targets = moveTargets(initialMoveChat([HIRING, BUDGET]), null);
    expect(targets.map((target) => [target.label, target.current, target.disabled])).toEqual([
      ['No project', true, true],
      ['Hiring', false, false],
      ['Budget', false, false],
    ]);
  });

  it('offers taking a chat in a project back out, and not its own project again', () => {
    const targets = moveTargets(initialMoveChat([HIRING, BUDGET]), HIRING.id);
    expect(targets.find((target) => target.projectId === null)?.disabled).toBe(false);
    expect(targets.find((target) => target.projectId === HIRING.id)).toMatchObject({
      current: true,
      disabled: true,
    });
  });

  it('opened from the chat itself, loads its projects before offering them', () => {
    const loading = initialMoveChat(null);
    expect(moveEmptyNote(loading)).toBe('Loading projects…');
    expect(moveTargets(loading, null).map((target) => target.label)).toEqual(['No project']);
    const loaded = fold(loading, { type: 'projectsLoaded', projects: [HIRING] });
    expect(moveEmptyNote(loaded)).toBeNull();
    expect(moveTargets(loaded, null).map((target) => target.label)).toEqual([
      'No project',
      'Hiring',
    ]);
  });

  it('says how to get a project when there are none', () => {
    expect(moveEmptyNote(initialMoveChat([]))).toMatch(/no projects yet/);
  });

  it('a list that fails to load says why, not that there are no projects', () => {
    const state = fold(initialMoveChat(null), { type: 'projectsFailed', error: 'Offline' });
    expect(state.error).toBe('Offline');
    expect(moveEmptyNote(state)).toBeNull();
  });

  it('holds every choice while a move is in flight, and a second press sends nothing', () => {
    const moving = fold(initialMoveChat([HIRING, BUDGET]), {
      type: 'moveStarted',
      projectId: HIRING.id,
    });
    expect(moveTargets(moving, null).every((target) => target.disabled)).toBe(true);
    expect(moveChatReducer(moving, { type: 'moveStarted', projectId: BUDGET.id })).toBe(moving);
  });

  it('a refused move keeps the dialog open, says why, and lets the person choose again', () => {
    const state = fold(
      initialMoveChat([HIRING]),
      { type: 'moveStarted', projectId: HIRING.id },
      { type: 'moveFailed', error: 'Wait for the current reply to finish first.' }
    );
    expect(state.error).toBe('Wait for the current reply to finish first.');
    expect(
      moveTargets(state, null).find((target) => target.projectId === HIRING.id)?.disabled
    ).toBe(false);
    expect(fold(state, { type: 'moveStarted', projectId: HIRING.id }).error).toBeNull();
  });
});
