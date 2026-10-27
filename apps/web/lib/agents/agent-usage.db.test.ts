/**
 * The per-model and per-run token reads against a real database
 * (skipped without DATABASE_URL), end to end from `recordLlmCall` — the
 * grouped SQL with its conditional agent filter is the part a unit test
 * cannot see. The models are named per run, so the organization-wide
 * split is exact however many runs share the database; the ledger keeps
 * its rows, as it does in production.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { recordLlmCall } from '@renkei/agents/runs';
import { getRunTokenUsage, getTokenUsageByModel, getTokenUsageByRun } from './agent-usage';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('token usage by model and by run', () => {
  const suiteId = randomUUID();
  const agentId = randomUUID();
  const stepId = randomUUID();
  const runId = randomUUID();
  const subject = `owner-${suiteId.slice(0, 8)}`;
  const bigModel = `claude-big-${suiteId.slice(0, 8)}`;
  const smallModel = `gpt-small-${suiteId.slice(0, 8)}`;
  beforeAll(async () => {
    await getDataStore().agents.create({
      id: agentId,
      ownerSubject: subject,
      name: 'Usage agent',
      instructions: '',
      tools: [],
      llmModelId: null,
      enabled: true,
      guardrails: null,
      canAskQuestions: false,
      autoAcceptActions: false,
    });

    const big = { provider: 'anthropic', model: bigModel, llmModelId: null };
    const small = { provider: 'openai', model: smallModel, llmModelId: null };
    const base = { subject, agentId, runId, stepId };
    await recordLlmCall({
      ...base,
      purpose: 'run',
      inputTokens: 100,
      outputTokens: 10,
      model: big,
    });
    await recordLlmCall({
      ...base,
      purpose: 'run',
      // 1,100 read in total, 900 of them from the cache (a portion, per LlmUsage).
      inputTokens: 1_100,
      outputTokens: 20,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 40,
      model: big,
    });
    await recordLlmCall({
      subject,
      agentId,
      purpose: 'optimize',
      inputTokens: 1_000,
      outputTokens: 50,
      model: small,
    });
    // A chat turn: the person's own spend, no agent.
    await recordLlmCall({
      subject,
      agentId: null,
      purpose: 'chat',
      inputTokens: 5_000,
      outputTokens: 500,
      model: big,
    });
    // A row from before the model was recorded.
    await recordLlmCall({ ...base, purpose: 'run', inputTokens: 7, outputTokens: 3 });
  });

  afterAll(async () => {
    await getDataStore().agents.delete(subject, agentId);
    await closeDataStore();
  });

  it('splits the whole org by model, chat and optimizer spend included', async () => {
    // Organization-wide, so other suites' rows in a shared database sit
    // beside these; the two models only this suite records are exact.
    const rows = await getTokenUsageByModel(null);
    const shaped = rows.map((row) => [
      row.provider,
      row.model,
      row.input.today,
      row.output.today,
      row.cacheRead.today,
      row.cacheWrite.today,
    ]);
    expect(shaped).toEqual(
      expect.arrayContaining([
        ['anthropic', bigModel, 6_200, 530, 900, 40],
        ['openai', smallModel, 1_000, 50, 0, 0],
      ])
    );
    const unrecorded = rows.find((row) => row.model === null);
    expect(unrecorded?.input.today).toBeGreaterThanOrEqual(7);
    expect(unrecorded?.output.today).toBeGreaterThanOrEqual(3);
  });

  it('narrows to one agent, leaving the chat out', async () => {
    const rows = await getTokenUsageByModel(agentId);
    expect(rows.map((row) => [row.model, row.input.allTime])).toEqual([
      [bigModel, 1_200],
      [smallModel, 1_000],
      [null, 7],
    ]);
    expect(await getTokenUsageByModel([])).toEqual([]);
  });

  it('totals one run at a time for a listing, absent when the ledger has nothing', async () => {
    const other = randomUUID();
    const byRun = await getTokenUsageByRun([runId, other]);
    expect(byRun[runId]).toEqual({
      input: 1_207,
      output: 33,
      cacheRead: 900,
      cacheWrite: 40,
      calls: 3,
    });
    expect(byRun[other]).toBeUndefined();
    expect(await getTokenUsageByRun([])).toEqual({});
  });

  it('splits one run by model', async () => {
    const rows = await getRunTokenUsage(runId);
    expect(
      rows.map((row) => [
        row.model,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.calls,
      ])
    ).toEqual([
      [bigModel, 1_200, 30, 900, 40, 2],
      [null, 7, 3, 0, 0, 1],
    ]);
    expect(await getRunTokenUsage(randomUUID())).toEqual([]);
  });
});
