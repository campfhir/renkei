/**
 * Agent memory against a real database (skipped without DATABASE_URL):
 * append/read round-trips, the one-summary invariant, the render budget,
 * and the compaction sweep folding old entries through a stubbed model.
 */

jest.mock('@renkei/agent-llm', () => ({ resolveAgentLlm: jest.fn() }));

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import {
  appendAgentMemory,
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

  // Acquired in beforeAll, not at describe-collection time: describe.skip still
  // runs its callback to register tests, so acquiring the database here (when
  // this suite is skipped for lack of DATABASE_URL) would throw at collection
  // and fail the whole file instead of skipping it.
  let db: Kysely<DB>;

  const tenantId = randomUUID();
  let agentId: string;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `mem-${tenantId.slice(0, 8)}` })
      .execute();
  });

  beforeEach(async () => {
    agentId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: 'owner-1',
        name: `mem-agent-${agentId.slice(0, 8)}`,
        steps: JSON.stringify({ version: 1, steps: [] }),
        enabled: true,
      })
      .execute();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await db.deleteFrom('agent_memories').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('agents').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('appends entries and reads them newest-first with the summary', async () => {
    await appendAgentMemory(db, { tenantId, agentId, content: 'handled message 1' });
    await appendAgentMemory(db, { tenantId, agentId, content: 'handled message 2' });
    await writeAgentMemorySummary(db, tenantId, agentId, 'the standing summary');

    const memory = await readAgentMemory(db, tenantId, agentId);
    expect(memory.summary).toBe('the standing summary');
    expect(memory.entries.map((entry) => entry.content)).toEqual([
      'handled message 2',
      'handled message 1',
    ]);
  });

  it('keeps exactly one summary row per agent across rewrites', async () => {
    await writeAgentMemorySummary(db, tenantId, agentId, 'first');
    await writeAgentMemorySummary(db, tenantId, agentId, 'second');
    const rows = await db
      .selectFrom('agent_memories')
      .select(['content'])
      .where('agent_id', '=', agentId)
      .where('kind', '=', 'summary')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('second');
  });

  it('renders within the injection budget however much is stored', async () => {
    await writeAgentMemorySummary(db, tenantId, agentId, 'S'.repeat(5_000));
    for (let index = 0; index < 30; index += 1) {
      await appendAgentMemory(db, {
        tenantId,
        agentId,
        content: `note ${index} ${'x'.repeat(400)}`,
      });
    }
    const rendered = renderAgentMemory(await readAgentMemory(db, tenantId, agentId));
    expect(rendered.length).toBeLessThanOrEqual(MEMORY_INJECT_MAX_CHARS);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('compaction folds old entries into the summary via the agent model', async () => {
    const total = MEMORY_COMPACT_THRESHOLD + 10;
    for (let index = 0; index < total; index += 1) {
      await appendAgentMemory(db, { tenantId, agentId, content: `did thing ${index}` });
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

    await createMemoryCompactionSweep(db)();

    const memory = await readAgentMemory(db, tenantId, agentId);
    expect(memory.summary).toContain('merged');
    // The newest window stays verbatim; the folded tail is gone.
    const remaining = await db
      .selectFrom('agent_memories')
      .select(['id'])
      .where('agent_id', '=', agentId)
      .where('kind', '=', 'entry')
      .execute();
    expect(remaining.length).toBeLessThan(total);
    expect(remaining.length).toBeGreaterThanOrEqual(MEMORY_KEEP_RECENT);
    expect(memory.entries[0]?.content).toBe(`did thing ${total - 1}`);
  });

  it('a failing model leaves everything in place for the next sweep', async () => {
    const total = MEMORY_COMPACT_THRESHOLD + 5;
    for (let index = 0; index < total; index += 1) {
      await appendAgentMemory(db, { tenantId, agentId, content: `did thing ${index}` });
    }
    mockResolveLlm.mockResolvedValue({ ok: false, err: { type: 'NO_MODEL' } });

    await createMemoryCompactionSweep(db)();

    const remaining = await db
      .selectFrom('agent_memories')
      .select(['id'])
      .where('agent_id', '=', agentId)
      .where('kind', '=', 'entry')
      .execute();
    expect(remaining).toHaveLength(total);
  });
});
