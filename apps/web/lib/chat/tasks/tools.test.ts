/**
 * The chat's task tools on the memory store, as a model uses them: a plan
 * made with subtasks and dependencies, started only once its dependencies
 * are done, completed and cancelled by the rules; chat_task_wait ending the
 * turn and the chat woken when its tasks finish or the wait times out; and
 * a sub-agent handed a task — in the foreground or the background — whose
 * report completes it and wakes the waiting chat.
 */

jest.mock('../chat-keys', () => ({
  chatCipherById: jest.fn(async () =>
    jest.requireActual('../content-crypto').resourceCipher({
      id: '00000000-0000-4000-8000-00000000c1fe',
      key: Buffer.alloc(32, 7),
    })
  ),
}));

jest.mock('../start-turn', () => ({ startChatTurn: jest.fn() }));

import { ok, err } from '@campfhir/safe-functions/helpers';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { LlmProvider, LlmResponse, ResolvedLlm } from '@renkei/agent-llm';
import { resourceCipher } from '../content-crypto';
import { createLocalToolSet, endsTurn, type LocalToolContext } from '../local-tools';
import { chatDelegateTool } from '../chat-delegate';
import { codeDelegateTool, type OpenSubagentCheckout } from '@/lib/code/delegate';
import { startInBackground } from '../subagent-tasks';
import { listTasks } from './store';
import { subagentTaskTools, taskTools, TASK_TOOL_NAMES } from './tools';
import { cancelTaskWait, getTaskWait, wakeIfReady, type OpenWakeTurn } from './wake';

const cipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});

let chatId = '';
let serial = 0;

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  serial += 1;
  chatId = `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;
});

afterEach(async () => {
  await cancelTaskWait(chatId);
  resetDataStore();
});

const context = (extra: Partial<LocalToolContext> = {}): LocalToolContext => ({
  subject: 'ann',
  roles: ['user'],
  chatId,
  cipher,
  projectId: null,
  readOnly: false,
  ...extra,
});

const tools = createLocalToolSet(taskTools());
async function call(
  name: string,
  input: Record<string, unknown>,
  extra?: Partial<LocalToolContext>
) {
  const result = await tools.run(name, input, context(extra));
  return {
    result,
    text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
  };
}

describe('the task tools', () => {
  it('are built in: none asks for permission, and a sub-agent gets all but the wait', () => {
    expect(taskTools().every((tool) => tool.readOnly === true)).toBe(true);
    expect(subagentTaskTools().map((tool) => tool.def.name)).not.toContain(TASK_TOOL_NAMES.wait);
    expect(subagentTaskTools()).toHaveLength(taskTools().length - 1);
  });

  it('plan a task with its steps as subtasks, numbered in order', async () => {
    const { text } = await call(TASK_TOOL_NAMES.create, {
      title: 'Prepare the quarterly review',
      subtasks: ['Pull the numbers', 'Draft the summary'],
    });
    expect(text).toContain('Created #1 [to do] Prepare the quarterly review');
    expect(text).toContain('#2 [to do] Pull the numbers — subtask of #1');
    expect(text).toContain('#3 [to do] Draft the summary — subtask of #1');
    const stored = await listTasks(chatId, cipher);
    expect(stored.map((task) => [task.number, task.parentId === stored[0].id])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
  });

  it('a task waiting on another cannot start until it is completed, and completing says what is now ready', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Gather' });
    await call(TASK_TOOL_NAMES.create, { title: 'Write', depends_on: [1] });
    const refused = await call(TASK_TOOL_NAMES.update, { task: '#2', status: 'in_progress' });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toBe('#2 cannot start yet: it depends on #1 (to do).');
    await call(TASK_TOOL_NAMES.update, {
      task: 1,
      status: 'in_progress',
      progress: 50,
      note: 'Half read',
    });
    const done = await call(TASK_TOOL_NAMES.complete, { task: 1, result: 'Three sources' });
    expect(done.text).toContain('Completed #1 [completed] Gather');
    expect(done.text).toContain('Now ready to start: #2 [to do] Write — after #1.');
    const started = await call(TASK_TOOL_NAMES.update, { task: 2, status: 'in_progress' });
    expect(started.result.isError).toBe(false);
    const got = await call(TASK_TOOL_NAMES.get, { task: 1 });
    expect(got.text).toContain('Result: Three sources');
  });

  it('a parent completes only once its subtasks are finished; a cancel takes them along', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Parent', subtasks: ['A', 'B'] });
    const refused = await call(TASK_TOOL_NAMES.complete, { task: 1 });
    expect(refused.text).toBe('#1 still has open subtasks: #2, #3. Complete or cancel them first.');
    const cancelled = await call(TASK_TOOL_NAMES.cancel, { task: 1, reason: 'Not needed' });
    expect(cancelled.text).toContain('Also cancelled its open subtasks: #2, #3.');
    const list = await call(TASK_TOOL_NAMES.list, {});
    expect(list.text).toContain('#2 [cancelled] A');
  });

  it('a failed task records why', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Reach the API', start: true });
    const failed = await call(TASK_TOOL_NAMES.complete, {
      task: 1,
      outcome: 'failed',
      result: 'The host refused',
    });
    expect(failed.text).toContain('Failed #1 [failed] Reach the API');
    expect((await listTasks(chatId, cipher))[0]).toMatchObject({
      status: 'failed',
      result: 'The host refused',
    });
  });

  it('deleting takes the subtree and frees what depended on it', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Old', subtasks: ['Old step'] });
    await call(TASK_TOOL_NAMES.create, { title: 'Next', depends_on: ['#1'] });
    const deleted = await call(TASK_TOOL_NAMES.delete, { task: 1 });
    expect(deleted.text).toBe('Deleted #1, #2.');
    const left = await listTasks(chatId, cipher);
    expect(left.map((task) => [task.number, task.dependsOn])).toEqual([[3, []]]);
  });

  it('lists as Markdown when asked', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'One' });
    const listed = await call(TASK_TOOL_NAMES.list, { format: 'markdown' });
    expect(listed.text).toContain('- [ ] **#1** One — _to do_');
  });
});

describe('suspending on tasks', () => {
  const startChatTurn = jest.requireMock<{ startChatTurn: jest.Mock }>(
    '../start-turn'
  ).startChatTurn;
  /** Let the tools' own look at the wait (wakeSoon) run to its end. */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  beforeEach(() => {
    startChatTurn.mockReset();
    startChatTurn.mockResolvedValue(ok({ turnId: 'turn-2' }));
  });

  it('chat_task_wait ends the turn and leaves a wait on the open tasks', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Research', start: true });
    await call(TASK_TOOL_NAMES.create, { title: 'Done already' });
    await call(TASK_TOOL_NAMES.complete, { task: 2 });
    const { result, text } = await call(TASK_TOOL_NAMES.wait, { timeout_minutes: 10 });
    expect(endsTurn(result)).toBe(true);
    expect(text).toContain('Suspended until all of #1 finish');
    const wait = await getTaskWait(chatId);
    expect(wait?.taskIds).toHaveLength(1);
    expect(wait?.mode).toBe('all');
  });

  it('answers at once, without suspending, when the tasks have already finished', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Quick' });
    await call(TASK_TOOL_NAMES.complete, { task: 1, result: 'ok' });
    const { result, text } = await call(TASK_TOOL_NAMES.wait, { tasks: [1] });
    expect(endsTurn(result)).toBe(false);
    expect(text).toContain('not suspended');
    expect(await getTaskWait(chatId)).toBeNull();
  });

  it('finishing the task wakes the chat with a note, as its owner with their roles — once', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Research', start: true });
    await call(TASK_TOOL_NAMES.wait, { tasks: [1] });
    expect(await wakeIfReady(chatId)).toBe(false);
    await call(TASK_TOOL_NAMES.complete, { task: 1, result: 'Found it' });
    await settle();
    expect(startChatTurn).toHaveBeenCalledTimes(1);
    expect(startChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { subject: 'ann', roles: ['user'] },
        chatId,
        kind: 'note',
        text: expect.stringContaining('Task wait finished'),
      })
    );
    expect(startChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Result: Found it') })
    );
    expect(await getTaskWait(chatId)).toBeNull();
    expect(await wakeIfReady(chatId)).toBe(false);
  });

  it('times out at its deadline', async () => {
    const opened: string[] = [];
    const open: OpenWakeTurn = async (input) => {
      opened.push(input.text);
      return { ok: true };
    };
    await call(TASK_TOOL_NAMES.create, { title: 'Slow', start: true });
    await call(TASK_TOOL_NAMES.wait, { timeout_minutes: 5 });
    expect(await wakeIfReady(chatId, { open })).toBe(false);
    const later = new Date(Date.now() + 6 * 60_000);
    expect(await wakeIfReady(chatId, { open, now: later })).toBe(true);
    expect(opened[0]).toContain('timed out');
  });

  it('a chat mid-turn keeps its wait for that turn’s end', async () => {
    startChatTurn.mockResolvedValue(err('ALREADY_RUNNING'));
    await call(TASK_TOOL_NAMES.create, { title: 'Work', start: true });
    await call(TASK_TOOL_NAMES.wait, {});
    await call(TASK_TOOL_NAMES.complete, { task: 1 });
    await settle();
    expect(startChatTurn).toHaveBeenCalledTimes(1);
    expect(await getTaskWait(chatId)).not.toBeNull();
    // The turn ended (start-turn.ts looks again): now it wakes.
    startChatTurn.mockResolvedValue(ok({ turnId: 'turn-3' }));
    expect(await wakeIfReady(chatId)).toBe(true);
  });

  it('cancel removes the wait without waking', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Work', start: true });
    await call(TASK_TOOL_NAMES.wait, {});
    const { text } = await call(TASK_TOOL_NAMES.wait, { cancel: true });
    expect(text).toBe('Wait removed.');
    expect(await getTaskWait(chatId)).toBeNull();
    expect(startChatTurn).not.toHaveBeenCalled();
  });
});

describe('a sub-agent on a task', () => {
  const done = (text: string): LlmResponse => ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 2 },
  });
  function llmReplying(replies: LlmResponse[]): ResolvedLlm {
    let index = 0;
    const provider: LlmProvider = {
      async complete() {
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return ok(reply);
      },
    };
    return {
      provider,
      modelConfigId: 'model-1',
      providerName: 'anthropic',
      model: 'claude-x',
      maxOutputTokens: 4096,
    };
  }
  const delegate = () =>
    chatDelegateTool({
      surface: { tools: [], discoverable: [], readOnlyTools: new Set(), mcp: null },
      localTools: [
        {
          def: {
            name: 'chat_read_attachment',
            description: 'read',
            inputSchema: { type: 'object' },
          },
          readOnly: true,
          async execute() {
            return { content: [{ type: 'text', text: 'file' }], isError: false, meta: {} };
          },
        },
      ],
    })!;

  it('records its steps as subtasks, and its report completes the task', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Summarise the file' });
    const llm = llmReplying([
      {
        content: [
          {
            type: 'tool_use',
            id: 's1',
            name: TASK_TOOL_NAMES.create,
            input: { title: 'Read the file', parent: 1 },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      done('The file is about the roadmap.'),
    ]);
    const result = await delegate().execute(
      { task: 'Summarise the file', task_id: 1 },
      context({ llm, toolUseId: 'd1' })
    );
    expect(result.isError).toBe(false);
    const tasks = await listTasks(chatId, cipher);
    expect(tasks.map((task) => [task.number, task.status, task.createdBy])).toEqual([
      [1, 'completed', 'assistant'],
      // Left open by the sub-agent: it ends with the task.
      [2, 'cancelled', 'subagent'],
    ]);
    // The report itself, without the run's counts above it.
    expect(tasks[0].result).toBe('The file is about the roadmap.');
  });

  it('in the background, returns at once and completes the task when it reports, holding the turn open meanwhile', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Look into it' });
    let release: (value: LlmResponse) => void = () => {};
    const llm: ResolvedLlm = {
      ...llmReplying([]),
      provider: {
        complete: () =>
          new Promise((resolve) => {
            release = (reply) => resolve(ok(reply));
          }),
      },
    };
    const holds: string[] = [];
    const result = await delegate().execute(
      { task: 'Look into it', task_id: '#1', background: true },
      context({
        llm,
        toolUseId: 'd1',
        holdTurn: () => {
          holds.push('held');
          return () => holds.push('released');
        },
      })
    );
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.isError).toBe(false);
    expect((await listTasks(chatId, cipher))[0].status).toBe('in_progress');
    expect(holds).toEqual(['held']);
    release(done('Nothing alarming.'));
    for (let i = 0; i < 50 && holds.length < 2; i += 1) await new Promise((r) => setImmediate(r));
    expect(holds).toEqual(['held', 'released']);
    const [settled] = await listTasks(chatId, cipher);
    expect(settled.status).toBe('completed');
    expect(settled.result).toBe('Nothing alarming.');
  });

  it('a background sub-agent needs a task, and a finished task is not handed out again', async () => {
    const llm = llmReplying([done('x')]);
    const none = await delegate().execute({ task: 'x', background: true }, context({ llm }));
    expect(none.isError).toBe(true);
    await call(TASK_TOOL_NAMES.create, { title: 'Old' });
    await call(TASK_TOOL_NAMES.complete, { task: 1 });
    const finished = await delegate().execute({ task: 'x', task_id: 1 }, context({ llm }));
    expect(finished.content[0]).toMatchObject({ text: '#1 is already completed.' });
  });
});

describe('a code project’s sub-agent handed a task', () => {
  const report = (text: string): LlmResponse => ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 2 },
  });
  /** A model whose one reply is held until the test lets it go. */
  function heldModel() {
    let release: (value: LlmResponse) => void = () => {};
    const llm: ResolvedLlm = {
      provider: {
        complete: () =>
          new Promise((resolve) => {
            release = (reply) => resolve(ok(reply));
          }),
      },
      modelConfigId: 'model-1',
      providerName: 'anthropic',
      model: 'claude-x',
      maxOutputTokens: 4096,
    };
    return { llm, release: (reply: LlmResponse) => release(reply) };
  }
  function worktrees(reason?: string) {
    const closed: string[] = [];
    const checkout: OpenSubagentCheckout = async (_context, key) =>
      reason
        ? { ok: false, reason }
        : {
            ok: true,
            checkout: {
              tools: [],
              branch: 'renkei/abc-sub-d1',
              from: 'renkei/abc',
              async close() {
                closed.push(key);
                return 'Merge renkei/abc-sub-d1.';
              },
            },
          };
    return { checkout, closed };
  }
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 100 && !until(); i += 1) await new Promise((r) => setImmediate(r));
  };

  it('in the background, answers at once so the orchestrator carries on, and its report and branch land on the task', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Build the parser' });
    const { llm, release } = heldModel();
    const { checkout, closed } = worktrees();
    const holds: string[] = [];
    const started = await codeDelegateTool([], { checkout }).execute(
      { task: 'Build the parser', task_id: 1, background: true },
      context({
        llm,
        toolUseId: 'd1',
        holdTurn: () => {
          holds.push('held');
          return () => holds.push('released');
        },
      })
    );
    // The call is back while the sub-agent has not said a word.
    expect(started.isError).toBe(false);
    expect(started.content[0]).toMatchObject({
      text: expect.stringContaining('Started a background sub-agent on #1'),
    });
    expect((await listTasks(chatId, cipher))[0].status).toBe('in_progress');
    expect(closed).toEqual([]);

    release(report('The parser is built.'));
    await settle(() => holds.length === 2);
    expect(holds).toEqual(['held', 'released']);
    expect(closed).toEqual(['d1']);
    const [task] = await listTasks(chatId, cipher);
    expect(task.status).toBe('completed');
    expect(task.result).toContain('The parser is built.');
    expect(task.result).toContain('Merge renkei/abc-sub-d1.');
  });

  it('is not started in the background without a task, in the chat’s own checkout, or when no worktree can be made', async () => {
    const { llm } = heldModel();
    const { checkout } = worktrees();
    const tool = codeDelegateTool([], { checkout });
    const noTask = await tool.execute({ task: 'x', background: true }, context({ llm }));
    expect(noTask.content[0]).toMatchObject({ text: expect.stringContaining('needs a task') });

    await call(TASK_TOOL_NAMES.create, { title: 'Piece' });
    const inPlace = await tool.execute(
      { task: 'x', task_id: 1, background: true, inPlace: true },
      context({ llm })
    );
    expect(inPlace.isError).toBe(true);

    const none = await codeDelegateTool([], {
      checkout: worktrees('this checkout is not on a branch right now.').checkout,
    }).execute({ task: 'x', task_id: 1, background: true }, context({ llm }));
    expect(none.content[0]).toMatchObject({
      text: expect.stringContaining('not on a branch right now'),
    });
    // Refused before the task was touched.
    expect((await listTasks(chatId, cipher))[0].status).toBe('pending');
  });

  it('is stopped when its task is cancelled under it', async () => {
    await call(TASK_TOOL_NAMES.create, { title: 'Long job' });
    const [task] = await listTasks(chatId, cipher);
    let stopped = false;
    startInBackground(
      context(),
      task,
      (running) =>
        new Promise((resolve) => {
          running.signal?.addEventListener('abort', () => {
            stopped = true;
            resolve({ content: [{ type: 'text', text: 'Stopped.' }], isError: true, meta: {} });
          });
        }),
      5
    );
    await call(TASK_TOOL_NAMES.cancel, { task: 1 });
    for (let i = 0; i < 100 && !stopped; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(stopped).toBe(true);
    // The person's cancel stands; the stopped run does not overwrite it.
    expect((await listTasks(chatId, cipher))[0].status).toBe('cancelled');
  });
});
