import type { ChatTaskView } from '@/lib/chat/tasks/graph';
import {
  dialogMarkdown,
  initTasksDialog,
  shouldPoll,
  taskActions,
  taskFacts,
  taskSections,
  taskSummary,
  tasksDialogReducer,
  waitSummary,
  type TasksDialogAction,
  type TasksDialogState,
} from './tasks-dialog.model';

function task(number: number, values: Partial<ChatTaskView> = {}): ChatTaskView {
  return {
    id: `t${number}`,
    number,
    parentId: null,
    title: `Task ${number}`,
    detail: null,
    status: 'pending',
    progress: null,
    progressNote: null,
    result: null,
    dependsOn: [],
    createdBy: 'assistant',
    createdAt: `2026-11-06T10:0${number}:00.000Z`,
    updatedAt: `2026-11-06T10:0${number}:00.000Z`,
    startedAt: null,
    finishedAt: null,
    ...values,
  };
}

const run = (actions: TasksDialogAction[], from: TasksDialogState = initTasksDialog()) =>
  actions.reduce(tasksDialogReducer, from);

const plan = [
  task(1, { status: 'completed', finishedAt: '2026-11-06T11:30:00.000Z', result: 'Found 3' }),
  task(2, { status: 'in_progress', progress: 40, progressNote: 'Halfway' }),
  task(3, { dependsOn: ['t2'] }),
  task(4, { parentId: 't2' }),
  task(5, { status: 'waiting' }),
  task(6, { status: 'cancelled', finishedAt: '2026-11-06T11:00:00.000Z' }),
  task(7),
];

describe('the tasks dialog', () => {
  it('shows a loading line until the list arrives, then the list', () => {
    expect(initTasksDialog().phase).toBe('loading');
    const state = run([{ type: 'loaded', tasks: plan, wait: null }]);
    expect(state.phase).toBe('ready');
    expect(state.tasks).toHaveLength(7);
  });

  it('a list that cannot be read says why; a failed poll after a good load keeps the list', () => {
    expect(run([{ type: 'loadFailed', message: 'No such chat' }])).toMatchObject({
      phase: 'failed',
      error: 'No such chat',
    });
    const state = run([
      { type: 'loaded', tasks: plan, wait: null },
      { type: 'loadFailed', message: 'offline' },
    ]);
    expect(state.phase).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.tasks).toHaveLength(7);
  });

  it('puts what is under way first — in progress, waiting and blocked, to do — then finished tasks in the order they finished', () => {
    const sections = taskSections(plan);
    expect(sections.map((s) => [s.label, s.tasks.map((t) => t.number)])).toEqual([
      ['In progress', [2]],
      ['Waiting', [3, 5]],
      ['To do', [4, 7]],
      ['Finished', [6, 1]],
    ]);
  });

  it('leaves out empty groups, and says when there is nothing yet', () => {
    expect(taskSections([task(1)]).map((s) => s.label)).toEqual(['To do']);
    expect(taskSections([])).toEqual([]);
    expect(taskSummary([])).toBe('No tasks yet');
    expect(taskSummary(plan)).toBe('1 of 7 completed');
  });

  it('names a task’s parent, and what it is blocked on or comes after', () => {
    expect(taskFacts(plan[2], plan)).toEqual(['waiting on #2']);
    expect(taskFacts(plan[3], plan)).toEqual(['subtask of #2']);
    const done = plan.map((t) => (t.id === 't2' ? { ...t, status: 'completed' as const } : t));
    expect(taskFacts(done[2], done)).toEqual(['after #2']);
  });

  it('lets the owner complete a task only once its subtasks are done, cancel or delete an open one, and delete a finished one', () => {
    expect(taskActions(plan[1], plan, true)).toEqual(['cancel', 'delete']);
    expect(taskActions(plan[6], plan, true)).toEqual(['complete', 'cancel', 'delete']);
    expect(taskActions(plan[0], plan, true)).toEqual(['delete']);
  });

  it('offers a viewer no actions', () => {
    expect(taskActions(plan[6], plan, false)).toEqual([]);
  });

  it('holds every button while one action is on its way, and takes the server’s list after', () => {
    let state = run([
      { type: 'loaded', tasks: plan, wait: null },
      { type: 'actionStarted', taskId: 't7', action: 'complete' },
      { type: 'actionStarted', taskId: 't5', action: 'cancel' },
    ]);
    expect(state.pending).toEqual({ taskId: 't7', action: 'complete' });
    state = run(
      [
        {
          type: 'actionDone',
          tasks: plan.map((t) => (t.id === 't7' ? { ...t, status: 'completed' as const } : t)),
        },
      ],
      state
    );
    expect(state.pending).toBeNull();
    expect(state.tasks.find((t) => t.id === 't7')?.status).toBe('completed');
  });

  it('a refused action keeps the list and shows why', () => {
    const state = run([
      { type: 'loaded', tasks: plan, wait: null },
      { type: 'actionStarted', taskId: 't2', action: 'complete' },
      { type: 'actionFailed', message: '#2 still has open subtasks: #4.' },
    ]);
    expect(state.pending).toBeNull();
    expect(state.error).toBe('#2 still has open subtasks: #4.');
    expect(state.tasks).toEqual(plan);
    expect(run([{ type: 'errorDismissed' }], state).error).toBeNull();
  });

  it('says what a suspended chat is waiting on', () => {
    const state = run([
      {
        type: 'loaded',
        tasks: plan,
        wait: { taskIds: ['t3', 't2'], events: ['completed'], mode: 'all', deadlineAt: null },
      },
    ]);
    expect(waitSummary(state)).toBe('all of #2, #3');
    expect(waitSummary(run([{ type: 'loaded', tasks: plan, wait: null }]))).toBeNull();
  });

  it('keeps asking while work is under way or the chat is waiting, and stops once all is settled', () => {
    expect(shouldPoll(initTasksDialog())).toBe(false);
    expect(shouldPoll(run([{ type: 'loaded', tasks: plan, wait: null }]))).toBe(true);
    const settled = [task(1, { status: 'completed' }), task(2)];
    expect(shouldPoll(run([{ type: 'loaded', tasks: settled, wait: null }]))).toBe(false);
    expect(
      shouldPoll(
        run([
          {
            type: 'loaded',
            tasks: settled,
            wait: { taskIds: ['t2'], events: ['completed'], mode: 'any', deadlineAt: null },
          },
        ])
      )
    ).toBe(true);
  });

  it('switches to Markdown — a checklist of the same list, with results — and copies it', () => {
    let state = run([
      { type: 'loaded', tasks: plan, wait: null },
      { type: 'viewChosen', view: 'markdown' },
      { type: 'copied' },
    ]);
    expect(state.view).toBe('markdown');
    expect(state.copied).toBe(true);
    const markdown = dialogMarkdown(state, 'Quarterly review');
    expect(markdown).toContain('# Tasks — Quarterly review');
    expect(markdown).toContain('- [x] **#1** Task 1');
    expect(markdown).toContain('> **Result:** Found 3');
    expect(markdown).toContain('- [ ] **#2** Task 2 — _in progress_, 40%');
    expect(markdown).toContain('  - [ ] **#4** Task 4 — _to do_');
    expect(markdown).toContain('~~Task 6~~');
    state = run([{ type: 'viewChosen', view: 'list' }], state);
    expect(state.copied).toBe(false);
  });
});
