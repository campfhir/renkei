/**
 * The pipeline assistant in the background: a job runs with its steps
 * readable as it goes, ends with the answer or why there is none, is
 * read only by the person who asked on that project, and one silent for
 * minutes reads as interrupted.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@renkei/agents/runs', () => ({ recordLlmCall: jest.fn(async () => ({ ok: true })) }));

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  INTERRUPTED,
  STALE_MS,
  meteredComplete,
  readAssistantJob,
  runAssistantJob,
  startAssistantJob,
} from './assistant-jobs';
import type { AssistantDeps, AssistantInput } from './pipeline-assistant';

const project = '00000000-0000-4000-8000-00000000c0de';
const about = { subject: 'ada', project: 'Billing', repository: 'acme/billing' };

const input: AssistantInput = {
  conversation: [{ role: 'user', text: 'Read the README.' }],
  spec: { checks: [], environments: [] },
  host: 'bitbucket',
  repo: 'acme/billing',
  branch: 'main',
  environment: 'production',
  blocks: [],
  targets: [],
  operator: false,
};

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

it('runs in the background: its steps read as it goes, then its answer', async () => {
  const id = randomUUID();
  await startAssistantJob(id, 'ada', project, new Date());
  expect(await readAssistantJob('ada', project, id, new Date())).toEqual({
    status: 'running',
    step: 'Starting',
  });

  let seenWhileReading: unknown = null;
  const complete = jest
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      val: {
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'README.md' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      val: {
        content: [{ type: 'text', text: 'It builds with pnpm.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
  const deps: Omit<AssistantDeps, 'onStep'> = {
    complete,
    maxOutputTokens: 1000,
    listFiles: async () => ({ ok: true, entries: [] }),
    readFile: async () => {
      seenWhileReading = await readAssistantJob('ada', project, id, new Date());
      return { ok: true, text: 'pnpm build', truncated: false, binary: false };
    },
  };
  await runAssistantJob(id, about, async () => ({ input, deps }));

  expect(seenWhileReading).toEqual({ status: 'running', step: 'Reading README.md' });
  expect(await readAssistantJob('ada', project, id, new Date())).toEqual({
    status: 'succeeded',
    answer: {
      reply: 'It builds with pnpm.',
      proposal: null,
      buildingBlock: null,
      read: ['README.md'],
    },
  });
});

it('ends with why there is no answer: the model, the setup, or a crash', async () => {
  const modelDown = randomUUID();
  await startAssistantJob(modelDown, 'ada', project, new Date());
  await runAssistantJob(modelDown, about, async () => ({
    input,
    deps: {
      complete: jest.fn().mockResolvedValue({ ok: false, err: { type: 'rate_limit' } }),
      maxOutputTokens: 1000,
      listFiles: async () => ({ ok: true, entries: [] }),
      readFile: async () => ({ ok: false, error: 'x' }),
    },
  }));
  expect(await readAssistantJob('ada', project, modelDown, new Date())).toEqual({
    status: 'failed',
    error: 'The model is rate-limiting right now; try again in a minute.',
  });

  const crashed = randomUUID();
  await startAssistantJob(crashed, 'ada', project, new Date());
  await runAssistantJob(crashed, about, async () => {
    throw new Error('boom');
  });
  expect(await readAssistantJob('ada', project, crashed, new Date())).toEqual({
    status: 'failed',
    error: 'The assistant failed while working it out; ask again.',
  });
});

it('is read only by the person who asked, on that project', async () => {
  const id = randomUUID();
  await startAssistantJob(id, 'ada', project, new Date());
  expect(await readAssistantJob('bob', project, id, new Date())).toBeNull();
  expect(
    await readAssistantJob('ada', '00000000-0000-4000-8000-00000000beef', id, new Date())
  ).toBeNull();
});

it('a job silent for minutes reads as interrupted, and yesterday’s are dropped', async () => {
  const id = randomUUID();
  const then = new Date('2026-11-19T10:00:00Z');
  await startAssistantJob(id, 'ada', project, then);
  expect(
    await readAssistantJob('ada', project, id, new Date(then.getTime() + STALE_MS - 1000))
  ).toMatchObject({ status: 'running' });
  expect(
    await readAssistantJob('ada', project, id, new Date(then.getTime() + STALE_MS + 1000))
  ).toEqual({ status: 'failed', error: INTERRUPTED });

  await startAssistantJob(randomUUID(), 'ada', project, new Date('2026-11-21T10:00:00Z'));
  expect(await getDataStore().ciAssistantJobs.find('ada', id)).toBeNull();
});

it('puts each model call of the assistant on the usage ledger as the asking person’s spend', async () => {
  const { recordLlmCall } = jest.requireMock<{ recordLlmCall: jest.Mock }>('@renkei/agents/runs');
  const answered = {
    ok: true as const,
    val: {
      content: [],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 1000 },
    },
  };
  const provider = { complete: jest.fn().mockResolvedValueOnce(answered) };
  const complete = meteredComplete(
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    { provider, providerName: 'anthropic', model: 'a-model', modelConfigId: 'cfg-1' } as never,
    'ada'
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  expect(await complete({} as never)).toBe(answered);
  expect(recordLlmCall).toHaveBeenCalledWith(
    expect.objectContaining({
      subject: 'ada',
      agentId: null,
      purpose: 'pipeline_assistant',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 1000,
      model: { provider: 'anthropic', model: 'a-model', llmModelId: 'cfg-1' },
    })
  );
});
