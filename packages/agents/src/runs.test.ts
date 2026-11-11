/**
 * Starting a run under a token limit: an agent's tokens are its owner's, so
 * the owner's limit decides whether a new run is made — whoever asked.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { invalidateSettingsCache, setOrgSettings } from '@renkei/settings';
import { ok } from '@campfhir/safe-functions/helpers';
import { createAgentRun } from './runs';

const AGENT = '00000000-0000-4000-8000-000000000001';
const MODEL = '00000000-0000-4000-8000-000000000901';

describe('createAgentRun under a token limit', () => {
  let store: MemoryDataStore;
  let enqueued: number;
  const producer: QueueProducer = {
    enqueue: async () => {
      enqueued += 1;
      return ok();
    },
  };

  async function spend(subject: string, tokens: number) {
    await store.usage.recordLlmCall({
      subject,
      agentId: AGENT,
      runId: null,
      stepId: null,
      purpose: 'run',
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      llmModelId: MODEL,
      provider: null,
      model: null,
      durationMs: null,
    });
  }

  function start(ownerSubject: string) {
    return createAgentRun(producer, {
      agentId: AGENT,
      ownerSubject,
      definition: { instructions: 'Do the thing.', tools: [] },
      llmModelId: MODEL,
      triggerId: null,
      triggerKind: 'schedule',
    });
  }

  beforeEach(() => {
    store = createMemoryDataStore();
    registerDataStore(store);
    invalidateSettingsCache();
    enqueued = 0;
  });
  afterEach(() => {
    resetDataStore();
    invalidateSettingsCache();
  });

  it('with no limit, the run is queued', async () => {
    await spend('ann', 1_000_000);
    expect((await start('ann')).ok).toBe(true);
    expect(enqueued).toBe(1);
  });

  it('an owner at their weekly limit gets no new run, and nothing is queued', async () => {
    await setOrgSettings({ tokenLimitWeekly: 1000 });
    await spend('ann', 1000);
    const result = await start('ann');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err.type).toBe('TOKEN_LIMIT');
    expect(result.err.message).toMatch(
      /^This agent's owner has reached the weekly token limit \(1K of 1K\)\. It resets /
    );
    expect(enqueued).toBe(0);
  });

  it('another owner under the limit still runs', async () => {
    await setOrgSettings({ tokenLimitWeekly: 1000 });
    await spend('ann', 1000);
    expect((await start('bob')).ok).toBe(true);
  });

  it('an exempt owner runs past the limit', async () => {
    await setOrgSettings({ tokenLimitWeekly: 1000 });
    await spend('ann', 5000);
    await store.tokenLimits.setExempt('ann', true, 'olive');
    expect((await start('ann')).ok).toBe(true);
  });

  it('a limit on the run’s model stops it', async () => {
    await setOrgSettings({ modelTokenLimits: { [MODEL]: { weekly: 0, monthly: 500 } } });
    await spend('ann', 500);
    const result = await start('ann');
    expect(result.ok ? null : result.err.type).toBe('TOKEN_LIMIT');
  });
});
