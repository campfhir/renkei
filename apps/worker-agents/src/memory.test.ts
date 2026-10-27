/**
 * Agent memory against a real database (skipped without DATABASE_URL):
 * append/read round-trips, the one-summary invariant, the render budget,
 * and the compaction sweep folding old entries through a stubbed model.
 */

jest.mock('@renkei/agent-llm', () => ({ resolveAgentLlm: jest.fn() }));
/**
 * The delegate's `user-sealed` ops, faked as a reversible, visibly marked
 * transform: what the rows hold is then checkable as "not plaintext" and
 * still readable by the test. The real envelope is the delegate's.
 */
const FAKE_SEAL = 'uenc1:test:';
jest.mock('@renkei/delegate-client', () => ({
  delegateClient: () => ({
    sealForSubject: async (_subject: string, values: string[]) => ({
      ok: true,
      val: values.map((value) => FAKE_SEAL + Buffer.from(value, 'utf8').toString('base64')),
    }),
    openForSubject: async (_subject: string, stored: string[]) => ({
      ok: true,
      val: stored.map((value) =>
        value.startsWith(FAKE_SEAL)
          ? Buffer.from(value.slice(FAKE_SEAL.length), 'base64').toString('utf8')
          : null
      ),
    }),
  }),
}));

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import {
  appendAgentMemory,
  countAgentMemory,
  forgetAgentMemory,
  readAgentMemory,
  renderAgentMemory,
  writeAgentMemorySummary,
  MEMORY_COMPACT_THRESHOLD,
  MEMORY_KEEP_RECENT,
  MEMORY_INJECT_MAX_CHARS,
} from '@renkei/agents/memory';
import { createMemoryCompactionSweep } from './memory-compaction';

const { resolveAgentLlm: mockResolveLlm } = jest.requireMock<{ resolveAgentLlm: jest.Mock }>(
  '@renkei/agent-llm'
);

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('agent memory', () => {
  jest.setTimeout(20_000);

  // Every test seeds a fresh agent under this run's own owner, so nothing
  // needs deleting afterwards and a shared database never collides.
  let agentId: string;
  const owner = `mem-owner-${randomUUID().slice(0, 8)}`;

  async function seedAgent(): Promise<string> {
    const id = randomUUID();
    await getDataStore().agents.create({
      id,
      ownerSubject: owner,
      name: `mem-agent-${id.slice(0, 8)}`,
      instructions: '',
      tools: [],
      llmModelId: null,
      enabled: true,
      guardrails: null,
      canAskQuestions: false,
      autoAcceptActions: false,
    });
    return id;
  }

  beforeEach(async () => {
    agentId = await seedAgent();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closeDataStore();
  });

  it('writes an identical entry once — a fact remembered every run is one line', async () => {
    const first = await appendAgentMemory({ agentId, content: 'replied to 123' });
    const again = await appendAgentMemory({ agentId, content: ' replied to 123 ' });
    const other = await appendAgentMemory({ agentId, content: 'replied to 124' });
    expect(first).toEqual({ inserted: true });
    expect(again).toEqual({ inserted: false });
    expect(other).toEqual({ inserted: true });

    const memory = await readAgentMemory(agentId);
    expect(memory.entries.map((entry) => entry.content)).toEqual([
      'replied to 124',
      'replied to 123',
    ]);
  });

  it('appends entries and reads them newest-first with the summary', async () => {
    await appendAgentMemory({ agentId, content: 'handled message 1' });
    await appendAgentMemory({ agentId, content: 'handled message 2' });
    await writeAgentMemorySummary(agentId, 'the standing summary');

    const memory = await readAgentMemory(agentId);
    expect(memory.summary).toBe('the standing summary');
    expect(memory.entries.map((entry) => entry.content)).toEqual([
      'handled message 2',
      'handled message 1',
    ]);
  });

  it('keeps exactly one summary row per agent across rewrites', async () => {
    await writeAgentMemorySummary(agentId, 'first');
    await writeAgentMemorySummary(agentId, 'second');
    // The rewrite replaced the one summary rather than adding a second row.
    expect(await getDataStore().agents.countMemory(agentId)).toEqual({
      entries: 0,
      hasSummary: true,
    });
    const { summary } = await getDataStore().agents.memorySlice(agentId, 10);
    // Sealed at rest: the row is an envelope, not the text.
    expect(summary?.content).toMatch(/^uenc1:/);
    expect(summary?.content).not.toContain('second');
    expect((await readAgentMemory(agentId)).summary).toBe('second');
  });

  it('writes no entry in plaintext, and still reads a plaintext row from before the sweep', async () => {
    await appendAgentMemory({ agentId, content: 'patient 123 was discharged' });
    const stored = (await getDataStore().agents.memorySlice(agentId, 10)).entries;
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toMatch(/^uenc1:/);
    expect(stored[0].content).not.toContain('discharged');

    // A row the rekey sweep has not reached yet reads as it is — nothing
    // goes dark on deploy — and the duplicate check sees it too.
    // (The store writes content as given; before sealing, the app gave it
    // plaintext.)
    await getDataStore().agents.addMemoryEntry({
      id: randomUUID(),
      agentId,
      content: 'legacy plaintext note',
      runId: null,
    });
    const memory = await readAgentMemory(agentId);
    expect(memory.unavailable).toBeNull();
    expect(memory.entries.map((entry) => entry.content).sort()).toEqual([
      'legacy plaintext note',
      'patient 123 was discharged',
    ]);
    expect(await appendAgentMemory({ agentId, content: 'legacy plaintext note' })).toEqual({
      inserted: false,
    });
  });

  it('renders within the injection budget however much is stored', async () => {
    await writeAgentMemorySummary(agentId, 'S'.repeat(5_000));
    for (let index = 0; index < 30; index += 1) {
      await appendAgentMemory({
        agentId,
        content: `note ${index} ${'x'.repeat(400)}`,
      });
    }
    const rendered = renderAgentMemory(await readAgentMemory(agentId));
    expect(rendered.length).toBeLessThanOrEqual(MEMORY_INJECT_MAX_CHARS);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('forgets named entries and reports ids that matched nothing', async () => {
    await appendAgentMemory({ agentId, content: 'keep me' });
    await appendAgentMemory({ agentId, content: 'forget me' });
    const before = await readAgentMemory(agentId);
    const doomed = before.entries.find((entry) => entry.content === 'forget me');
    const absent = randomUUID();

    // A malformed id rides along: it must come back missing, not blow the
    // batch up on the uuid cast.
    const result = await forgetAgentMemory(agentId, {
      kind: 'entries',
      entryIds: [doomed!.id, absent, 'not-a-uuid'],
    });

    expect(result.entriesDeleted).toBe(1);
    expect(result.missingIds).toEqual([absent, 'not-a-uuid']);
    const after = await readAgentMemory(agentId);
    expect(after.entries.map((entry) => entry.content)).toEqual(['keep me']);
  });

  it("will not delete another agent's entry, even with its real id", async () => {
    const otherId = await seedAgent();
    await appendAgentMemory({ agentId: otherId, content: 'theirs' });
    const theirs = (await readAgentMemory(otherId)).entries[0];

    const result = await forgetAgentMemory(agentId, {
      kind: 'entries',
      entryIds: [theirs.id],
    });

    expect(result.entriesDeleted).toBe(0);
    expect(result.missingIds).toEqual([theirs.id]);
    expect((await readAgentMemory(otherId)).entries).toHaveLength(1);
  });

  it('clears the summary alone, leaving entries in place', async () => {
    await appendAgentMemory({ agentId, content: 'still here' });
    await writeAgentMemorySummary(agentId, 'the standing summary');

    const result = await forgetAgentMemory(agentId, { kind: 'summary' });

    expect(result.summaryCleared).toBe(true);
    const memory = await readAgentMemory(agentId);
    expect(memory.summary).toBeNull();
    expect(memory.entries).toHaveLength(1);
  });

  it('counts what is held, then all clears every row', async () => {
    await appendAgentMemory({ agentId, content: 'one' });
    await appendAgentMemory({ agentId, content: 'two' });
    await writeAgentMemorySummary(agentId, 'summary');

    expect(await countAgentMemory(agentId)).toEqual({
      entries: 2,
      hasSummary: true,
    });

    const result = await forgetAgentMemory(agentId, { kind: 'all' });

    expect(result).toEqual({ entriesDeleted: 2, summaryCleared: true, missingIds: [] });
    expect(await readAgentMemory(agentId)).toEqual({
      summary: null,
      summaryUpdatedAt: null,
      entries: [],
      unavailable: null,
    });
  });

  it('compaction folds old entries into the summary via the agent model', async () => {
    const total = MEMORY_COMPACT_THRESHOLD + 10;
    for (let index = 0; index < total; index += 1) {
      await appendAgentMemory({ agentId, content: `did thing ${index}` });
    }
    mockResolveLlm.mockResolvedValue({
      ok: true,
      val: {
        modelConfigId: randomUUID(),
        maxOutputTokens: 1_000,
        provider: {
          complete: jest.fn(async () => ({
            ok: true,
            val: {
              content: [{ type: 'text', text: 'merged: things 0 through many were done' }],
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          })),
        },
      },
    });

    await createMemoryCompactionSweep()();

    const memory = await readAgentMemory(agentId);
    expect(memory.summary).toContain('merged');
    // The newest window stays verbatim; the folded tail is gone.
    const remaining = (await getDataStore().agents.countMemory(agentId)).entries;
    expect(remaining).toBeLessThan(total);
    expect(remaining).toBeGreaterThanOrEqual(MEMORY_KEEP_RECENT);
    expect(memory.entries[0]?.content).toBe(`did thing ${total - 1}`);
  });

  it('a failing model leaves everything in place for the next sweep', async () => {
    const total = MEMORY_COMPACT_THRESHOLD + 5;
    for (let index = 0; index < total; index += 1) {
      await appendAgentMemory({ agentId, content: `did thing ${index}` });
    }
    mockResolveLlm.mockResolvedValue({ ok: false, err: { type: 'NO_MODEL' } });

    await createMemoryCompactionSweep()();

    expect((await getDataStore().agents.countMemory(agentId)).entries).toBe(total);
  });
});
