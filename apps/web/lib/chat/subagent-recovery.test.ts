/**
 * A background sub-agent whose process died, on the memory store: its run
 * stops reading "working", the task it was on is failed with the reason,
 * and one still being touched — or under a turn still running — is left
 * alone.
 */

jest.mock('./chat-keys', () => ({
  cipherAsOwner: jest.fn(async () =>
    jest.requireActual('./content-crypto').resourceCipher({
      id: '00000000-0000-4000-8000-00000000c1fe',
      key: Buffer.alloc(32, 7),
    })
  ),
  chatCipherById: jest.fn(),
}));
jest.mock('./store', () => ({
  getChatRow: jest.fn(async (id: string) => ({ id, ownerSubject: 'ann' })),
}));
jest.mock('./start-turn', () => ({ startChatTurn: jest.fn() }));

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { resourceCipher } from './content-crypto';
import { insertMessage } from './messages';
import {
  SUBAGENT_IDLE_SECONDS,
  SUBAGENT_LOST_ERROR,
  SUBAGENT_LOST_TASK_RESULT,
  interruptLostSubagentRuns,
} from './subagent-recovery';
import { createSubagentRun, getSubagentRunByCall } from './subagent-runs';
import { changeTask, createTask, listTasks } from './tasks/store';

const cipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});
const CHAT = '00000000-0000-4000-8000-0000000000c1';
const TURN = '00000000-0000-4000-8000-0000000000d1';

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

/** A turn that delegated `task_id` to a background sub-agent, whose run was started. */
async function delegated(toolUseId: string, taskId?: number) {
  await insertMessage({
    chatId: CHAT,
    turnId: TURN,
    role: 'assistant',
    kind: 'assistant',
    status: 'complete',
    blocks: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'code_delegate',
        input: { task: 'Build it', background: true, ...(taskId ? { task_id: taskId } : {}) },
      },
    ],
    cipher,
  });
  await createSubagentRun({
    chatId: CHAT,
    turnId: TURN,
    toolUseId,
    task: 'Build it',
    instructions: null,
    readOnly: false,
    maxSteps: 40,
    model: null,
    cipher,
  });
}

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);

describe('a sub-agent that lost its process', () => {
  it('is marked interrupted and its task failed once it has gone untouched long enough', async () => {
    await createTask(
      CHAT,
      cipher,
      { title: 'Build the parser', createdBy: 'assistant' },
      new Date()
    );
    await changeTask(CHAT, cipher, 1, { status: 'in_progress' }, new Date());
    await delegated('tu-1', 1);

    // Still inside the grace: a heartbeat may only be late.
    expect(await interruptLostSubagentRuns(later(SUBAGENT_IDLE_SECONDS - 30))).toBe(0);
    expect((await getSubagentRunByCall(CHAT, 'tu-1', cipher))?.status).toBe('running');

    expect(await interruptLostSubagentRuns(later(SUBAGENT_IDLE_SECONDS + 30))).toBe(1);
    const run = await getSubagentRunByCall(CHAT, 'tu-1', cipher);
    expect(run?.status).toBe('interrupted');
    expect(run?.error).toBe(SUBAGENT_LOST_ERROR);
    const [task] = await listTasks(CHAT, cipher);
    expect(task.status).toBe('failed');
    expect(task.result).toBe(SUBAGENT_LOST_TASK_RESULT);

    // Once: the next pass finds nothing left.
    expect(await interruptLostSubagentRuns(later(SUBAGENT_IDLE_SECONDS + 60))).toBe(0);
  });

  it('leaves a task the person already finished as they left it, and needs no task at all', async () => {
    await createTask(
      CHAT,
      cipher,
      { title: 'Cancelled meanwhile', createdBy: 'assistant' },
      new Date()
    );
    await changeTask(CHAT, cipher, 1, { status: 'cancelled' }, new Date());
    await delegated('tu-2', 1);
    await delegated('tu-3');
    expect(await interruptLostSubagentRuns(later(SUBAGENT_IDLE_SECONDS + 30))).toBe(2);
    expect((await listTasks(CHAT, cipher))[0].status).toBe('cancelled');
    expect((await getSubagentRunByCall(CHAT, 'tu-3', cipher))?.status).toBe('interrupted');
  });
});
