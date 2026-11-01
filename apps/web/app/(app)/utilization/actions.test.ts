/**
 * My usage's report (getUtilizationReport), on the memory store: the
 * buckets Organization usage charts, read for the signed-in person alone.
 * What my-usage.spec.ts checked through the page before — a second person
 * spends millions of tokens on the same server and none of it reaches this
 * report, not in a figure and not as a ranking of people — is held here;
 * the spec keeps the page's render, the chart's series switch and the
 * phone-width fit.
 */

jest.mock('@/lib/session', () => ({ getSessionFromCookies: jest.fn() }));
// No speech service configured (it would read an encryption key from the environment).
jest.mock('@/lib/voice/config', () => ({ resolveVoiceProvider: jest.fn(async () => null) }));

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { recordLlmCall } from '@renkei/agents/runs';
import { getUtilizationReport } from './actions';

const { getSessionFromCookies: mockSession } = jest.requireMock<{
  getSessionFromCookies: jest.Mock;
}>('@/lib/session');

const model = { provider: 'openai', model: 'stub-model', llmModelId: null };

let me: string;
let them: string;

beforeEach(async () => {
  registerDataStore(createMemoryDataStore());
  me = `me-${randomUUID()}`;
  them = `heavy-spender-${randomUUID()}`;
  // The person is an operator on purpose: the one caller who can see
  // everyone on Organization usage still gets only themselves here.
  mockSession.mockResolvedValue({ subject: me, roles: ['renkei-user', 'renkei-operator'] });

  // Mine: a chat reply of 4,000 in and 1,000 out, and an agent's call.
  await recordLlmCall({
    subject: me,
    agentId: null,
    purpose: 'chat',
    inputTokens: 4_000,
    outputTokens: 1_000,
    model,
  });
  await recordLlmCall({
    subject: me,
    agentId: randomUUID(),
    purpose: 'run',
    inputTokens: 300,
    outputTokens: 30,
    model,
  });
  // Somebody else's: nine million tokens out, on the same model and an agent of theirs.
  await recordLlmCall({
    subject: them,
    agentId: null,
    purpose: 'chat',
    inputTokens: 1,
    outputTokens: 9_000_000,
    model,
  });
  await recordLlmCall({
    subject: them,
    agentId: randomUUID(),
    purpose: 'run',
    inputTokens: 5_000_000,
    outputTokens: 1,
    model: { provider: 'anthropic', model: 'their-model', llmModelId: null },
  });
});

afterEach(() => {
  resetDataStore();
  jest.clearAllMocks();
});

describe('My usage', () => {
  it('puts my model on the board with my tokens, and nobody else’s', async () => {
    const report = await getUtilizationReport('1m', 'UTC');
    expect(report.error).toBeUndefined();
    expect(report.byModel).toEqual([
      expect.objectContaining({
        provider: 'openai',
        model: 'stub-model',
        inputTokens: 4_300,
        outputTokens: 1_030,
        calls: 2,
      }),
    ]);
  });

  it('splits only my tokens by surface: their agent’s spend is not in my agents bucket', async () => {
    const report = await getUtilizationReport('1m', 'UTC');
    expect(report.surfaceTokens.agents).toEqual({ input: 300, output: 30 });
  });

  it('charts and totals only my spend, in every bucket of the window', async () => {
    const report = await getUtilizationReport('1m', 'UTC');
    expect(report.totals.inputTokens + report.totals.outputTokens).toBeLessThan(10_000);
    const agentTokens = report.series.reduce((sum, bucket) => sum + bucket.agentTokens, 0);
    expect(agentTokens).toBe(330);
    expect(report.cells.length).toBeGreaterThan(0);
  });

  it('ranks nobody: the report has no board of people, and names no one else', async () => {
    const report = await getUtilizationReport('1m', 'UTC');
    for (const key of ['topUsers', 'topListeners', 'topSpeakers', 'topImageCreators', 'people']) {
      expect(report).not.toHaveProperty(key);
    }
    expect(JSON.stringify(report)).not.toContain(them);
    expect(JSON.stringify(report)).not.toContain('their-model');
  });

  it('a longer window reads in the same scope', async () => {
    const report = await getUtilizationReport('1q', 'UTC');
    expect(report.days).toBe(90);
    expect(report.byModel.map((row) => row.model)).toEqual(['stub-model']);
    expect(JSON.stringify(report)).not.toContain(them);
  });

  it('asks a signed-out caller to sign in, and reads nothing', async () => {
    mockSession.mockResolvedValue(null);
    const report = await getUtilizationReport('1m', 'UTC');
    expect(report).toMatchObject({ signedOut: true, byModel: [], series: [] });
  });

  it('turns away a session with no role in the tenant', async () => {
    mockSession.mockResolvedValue({ subject: me, roles: [] });
    const report = await getUtilizationReport('1m', 'UTC');
    expect(report.error).toBe('Your account has no role in this tenant');
    expect(report.byModel).toEqual([]);
  });
});
