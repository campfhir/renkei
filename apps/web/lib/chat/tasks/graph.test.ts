/**
 * The task list's rules, as the model, the person and the page all meet
 * them: which status may follow which, what a dependency blocks, what a
 * cancel takes along, when a suspended chat's wait fires, and how the
 * list reads as text and Markdown.
 */

import {
  dependencyRefusal,
  displayState,
  findTask,
  statusChange,
  taskTree,
  tasksMarkdown,
  waitFiring,
  wakeNoteText,
  type ChatTaskView,
  type TaskWaitView,
} from './graph';

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
    createdAt: '2026-11-06T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...values,
  };
}

const NOW = new Date('2026-11-06T12:00:00.000Z');

describe('finding a task', () => {
  const tasks = [task(1), task(12)];
  it('by number, as 3 or "#3" or "3", or by id', () => {
    expect(findTask(tasks, 12)?.id).toBe('t12');
    expect(findTask(tasks, '#12')?.id).toBe('t12');
    expect(findTask(tasks, ' 1 ')?.id).toBe('t1');
    expect(findTask(tasks, 't12')?.number).toBe(12);
    expect(findTask(tasks, '#4')).toBeNull();
    expect(findTask(tasks, null)).toBeNull();
  });
});

describe('dependencies', () => {
  const tasks = [
    task(1),
    task(2, { dependsOn: ['t1'] }),
    task(3, { parentId: 't1' }),
    task(4, { parentId: 't3' }),
  ];

  it('a task waiting on unfinished work shows as blocked, and is ready once it completes', () => {
    expect(displayState(tasks[1], tasks)).toBe('blocked');
    const done = tasks.map((t) => (t.id === 't1' ? { ...t, status: 'completed' as const } : t));
    expect(displayState(done[1], done)).toBe('pending');
  });

  it('refuses a task that is not in the chat, the task itself, or a cycle', () => {
    expect(dependencyRefusal(null, null, ['t9'], tasks)).toContain('No task t9');
    expect(dependencyRefusal('t2', null, ['t2'], tasks)).toBe('A task cannot depend on itself.');
    expect(dependencyRefusal('t1', null, ['t2'], tasks)).toContain('cycle');
  });

  it('refuses a parent or a subtask: either way round it would never start', () => {
    expect(dependencyRefusal('t4', 't3', ['t1'], tasks)).toContain('#1 is a parent');
    expect(dependencyRefusal('t1', null, ['t4'], tasks)).toContain('#4 is a subtask');
    expect(dependencyRefusal(null, 't3', ['t2'], tasks)).toBeNull();
  });
});

describe('status changes', () => {
  const tasks = [
    task(1, { status: 'in_progress' }),
    task(2, { dependsOn: ['t1'] }),
    task(3, { parentId: 't1' }),
    task(4, { parentId: 't3', status: 'completed' }),
    task(5, { parentId: 't1', status: 'failed' }),
    task(6, { status: 'completed' }),
  ];

  it('a task cannot start until what it depends on is completed', () => {
    const refused = statusChange(tasks[1], 'in_progress', tasks);
    expect(refused).toEqual({
      ok: false,
      reason: '#2 cannot start yet: it depends on #1 (in progress).',
    });
  });

  it('a task cannot complete while a subtask is still open', () => {
    expect(statusChange(tasks[0], 'completed', tasks)).toEqual({
      ok: false,
      reason: '#1 still has open subtasks: #3. Complete or cancel them first.',
    });
    expect(statusChange(tasks[2], 'completed', tasks)).toEqual({ ok: true, cascade: [] });
  });

  it('cancelling takes the open subtasks along, never the finished ones', () => {
    const allowed = statusChange(tasks[0], 'cancelled', tasks);
    expect(allowed.ok && allowed.cascade.map((t) => t.number)).toEqual([3]);
  });

  it('failing is always allowed; a finished task stays finished', () => {
    expect(statusChange(tasks[0], 'failed', tasks).ok).toBe(true);
    const again = statusChange(tasks[5], 'in_progress', tasks);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.reason).toContain('stays finished');
  });
});

describe('a suspended chat’s wait', () => {
  const wait = (values: Partial<TaskWaitView> = {}): TaskWaitView => ({
    taskIds: ['t1', 't2'],
    events: ['completed', 'failed', 'cancelled'],
    mode: 'all',
    deadlineAt: '2026-11-06T13:00:00.000Z',
    ...values,
  });

  it('waiting on all: keeps waiting while one is open, fires once every one has finished', () => {
    const tasks = [task(1, { status: 'completed' }), task(2, { status: 'in_progress' })];
    expect(waitFiring(wait(), tasks, NOW)).toBeNull();
    const finished = [task(1, { status: 'completed' }), task(2, { status: 'completed' })];
    expect(waitFiring(wait(), finished, NOW)?.reason).toBe('satisfied');
  });

  it('waiting on all fails fast: a failure it listens for wakes it at once', () => {
    const tasks = [task(1, { status: 'failed' }), task(2, { status: 'in_progress' })];
    expect(waitFiring(wait(), tasks, NOW)?.reason).toBe('failed-fast');
    expect(waitFiring(wait({ events: ['completed'] }), tasks, NOW)).toBeNull();
  });

  it('waiting on any: the first finish it listens for wakes it', () => {
    const tasks = [task(1, { status: 'cancelled' }), task(2, { status: 'in_progress' })];
    expect(waitFiring(wait({ mode: 'any', events: ['completed'] }), tasks, NOW)).toBeNull();
    expect(waitFiring(wait({ mode: 'any' }), tasks, NOW)?.reason).toBe('satisfied');
  });

  it('times out at its deadline, and ends when its tasks are deleted', () => {
    const open = [task(1), task(2)];
    expect(waitFiring(wait(), open, new Date('2026-11-06T13:00:00.000Z'))?.reason).toBe('timeout');
    expect(waitFiring(wait(), [task(3)], NOW)?.reason).toBe('gone');
  });

  it('the note it wakes with names why, each task and its result', () => {
    const tasks = [
      task(1, { status: 'completed', result: 'Found 3 open incidents' }),
      task(2, { status: 'completed' }),
    ];
    const firing = waitFiring(wait(), tasks, NOW);
    const text = wakeNoteText(firing!, tasks);
    expect(text).toContain('Task wait finished');
    expect(text).toContain('#1 [completed] Task 1');
    expect(text).toContain('Result: Found 3 open incidents');
  });
});

describe('the list as text', () => {
  const tasks = [
    task(1, { status: 'completed', result: 'Done well' }),
    task(2, { status: 'in_progress', progress: 30, progressNote: 'Reading' }),
    task(3, { parentId: 't2', dependsOn: ['t1'] }),
    task(4, { status: 'cancelled' }),
  ];

  it('the tools see a tree with states, progress and dependencies', () => {
    expect(taskTree(tasks)).toBe(
      [
        '- #1 [completed] Task 1',
        '- #2 [in progress 30%] Task 2 — Reading',
        '  - #3 [to do] Task 3 — subtask of #2; after #1',
        '- #4 [cancelled] Task 4',
      ].join('\n')
    );
    expect(taskTree([])).toBe('No tasks yet.');
  });

  it('the person gets a Markdown checklist, results on request', () => {
    expect(tasksMarkdown(tasks, { title: 'Review', results: true })).toBe(
      [
        '# Tasks — Review',
        '',
        '1 of 4 completed.',
        '',
        '- [x] **#1** Task 1',
        '  > **Result:** Done well',
        '- [ ] **#2** Task 2 — _in progress_, 30%',
        '  > Reading',
        '  - [ ] **#3** Task 3 — _to do_, after #1',
        '- [ ] **#4** ~~Task 4~~ — _cancelled_',
        '',
      ].join('\n')
    );
    expect(tasksMarkdown([])).toBe('# Tasks\n\n_No tasks yet._\n');
  });
});
