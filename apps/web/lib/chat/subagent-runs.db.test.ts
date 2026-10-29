/**
 * A sub-agent's run against a real database (skipped without
 * DATABASE_URL): the model it ran on (migration 118) is kept with the run
 * and read back with the config's label as it is today — and stands on
 * its name columns alone once that config is gone. Content sealing is
 * stood in for: no content key here, and the envelope is the crypto
 * package's concern.
 */

jest.mock('./content-crypto', () => ({
  ...jest.requireActual<typeof import('./content-crypto')>('./content-crypto'),
  sealText: (text: string) => ({ ok: true, val: text }),
  openText: (stored: string) => stored,
}));

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { createSubagentRun, finishSubagentRun, getSubagentRunByCall } from './subagent-runs';
import { resourceCipher } from './content-crypto';

/** A chat key for the fixtures: the ciphers under test only care that one is there. */
const testCipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat_subagent_runs model', () => {
  const suiteId = randomUUID();
  const subject = `owner-${suiteId.slice(0, 8)}`;
  // Labels are unique organization-wide: this suite's is its own.
  const fastLabel = `Fast model ${suiteId}`;
  const fastModelId = randomUUID();
  let chatId = '';
  let turnId = '';

  beforeAll(async () => {
    const store = getDataStore();
    chatId = await store.chats.create({
      ownerSubject: subject,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    turnId = await store.chatThreads.createTurn({
      chatId,
      kind: 'reply',
      llmModelId: null,
      thinkingBudget: null,
      runner: null,
    });
    const created = await store.llmModels.create(fastModelId, {
      label: fastLabel,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      baseUrl: null,
      settings: {},
      encryptedSecrets: 'sealed',
      enabled: true,
      isDefault: false,
    });
    if (created !== 'created') throw new Error(`model not created: ${created}`);
  });

  afterAll(async () => {
    // The chat's turns and sub-agent runs go with it.
    const store = getDataStore();
    await store.chats.delete(subject, chatId);
    await store.llmModels.delete(fastModelId);
    await closeDataStore();
  });

  it('keeps the model a run started on and reads it back with its label, then without', async () => {
    const runId = await createSubagentRun({
      chatId,
      turnId,
      toolUseId: 'toolu_fast',
      task: 'Find every caller of foo',
      instructions: null,
      readOnly: true,
      maxSteps: 10,
      model: { provider: 'anthropic', model: 'claude-haiku-4-5', llmModelId: fastModelId },
      cipher: testCipher,
    });
    expect(runId).not.toBeNull();
    await finishSubagentRun(
      runId!,
      {
        status: 'completed',
        transcript: [],
        report: 'three callers',
        error: null,
        steps: 2,
        toolCalls: 3,
      },
      testCipher
    );
    const run = await getSubagentRunByCall(chatId, 'toolu_fast', testCipher);
    expect(run?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      label: fastLabel,
    });

    // The config removed: the run still says what answered, by name.
    expect(await getDataStore().llmModels.delete(fastModelId)).toBe(true);
    const later = await getSubagentRunByCall(chatId, 'toolu_fast', testCipher);
    expect(later?.model).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5', label: null });
  });

  it('records no model for a run started without one, as before the column existed', async () => {
    const runId = await createSubagentRun({
      chatId,
      turnId,
      toolUseId: 'toolu_plain',
      task: 'do it',
      instructions: null,
      readOnly: false,
      maxSteps: 10,
      model: null,
      cipher: testCipher,
    });
    expect(runId).not.toBeNull();
    const run = await getSubagentRunByCall(chatId, 'toolu_plain', testCipher);
    expect(run?.model).toBeNull();
  });
});
