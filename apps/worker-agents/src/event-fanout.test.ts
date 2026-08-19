/**
 * Event → run fan-out against a real database (skipped without
 * DATABASE_URL). What must hold: only the event owner's enabled agents
 * fire, match filters filter, and the event payload arrives as the run's
 * initial state.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import type { AgentStepsDoc } from '@renkei/agents';
import { fanOutAgentEvents } from '@renkei/agents/event-fanout';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('agent event fan-out', () => {
  jest.setTimeout(20_000);

  // Acquired in beforeAll, not at describe-collection time: describe.skip still
  // runs its callback to register tests, so acquiring the database here (when
  // this suite is skipped for lack of DATABASE_URL) would throw at collection
  // and fail the whole file instead of skipping it.
  let db: Kysely<DB>;

  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;

  const steps: AgentStepsDoc = {
    version: 1,
    steps: [
      {
        id: randomUUID(),
        name: 'React',
        instruction: [{ t: 'text', v: 'React to the email' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      },
    ],
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `fanout-test-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_triggers WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  async function seedEventAgent(
    ownerSubject: string,
    options: { enabled?: boolean; match?: Record<string, string> } = {}
  ): Promise<string> {
    const agentId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: ownerSubject,
        name: `fanout-agent-${agentId.slice(0, 8)}`,
        steps: JSON.stringify(steps),
        enabled: options.enabled ?? true,
      })
      .execute();
    await db
      .insertInto('agent_triggers')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        agent_id: agentId,
        kind: 'event',
        event_source: 'microsoft',
        event_type: 'mail.received',
        config: JSON.stringify({ match: options.match ?? {} }),
        enabled: true,
      })
      .execute();
    return agentId;
  }

  const mailEvent = (ownerSubject: string, overrides: Record<string, unknown> = {}) => ({
    tenantId,
    source: 'microsoft',
    type: 'mail.received',
    ownerSubject,
    payload: {
      subject: 'PROJ-42 is broken',
      body: 'The printer is on fire again',
      from: 'reporter@customer.example',
      messageId: 'msg-1',
      ...overrides,
    },
  });

  it('fires only the owner’s enabled agents, with the payload as state', async () => {
    const ownersAgent = await seedEventAgent(owner);
    await seedEventAgent(stranger); // someone else's — must not fire
    await seedEventAgent(owner, { enabled: false }); // switched off — must not fire

    const queue = new InMemoryQueue();
    const started = await fanOutAgentEvents(db, queue.producer, mailEvent(owner));
    expect(started).toHaveLength(1);

    const run = await db
      .selectFrom('agent_runs')
      .select(['agent_id', 'trigger_kind', 'initial_state'])
      .where('id', '=', started[0])
      .executeTakeFirstOrThrow();
    expect(run.agent_id).toBe(ownersAgent);
    expect(run.trigger_kind).toBe('event');
    const state: { subject?: unknown } =
      typeof run.initial_state === 'object' &&
      run.initial_state !== null &&
      !Array.isArray(run.initial_state)
        ? run.initial_state
        : {};
    expect(state.subject).toBe('PROJ-42 is broken');
  });

  it('applies match filters', async () => {
    const filtered = await seedEventAgent(owner, { match: { fromDomain: 'customer.example' } });
    const other = await seedEventAgent(owner, { match: { fromDomain: 'elsewhere.example' } });

    const queue = new InMemoryQueue();
    const started = await fanOutAgentEvents(db, queue.producer, mailEvent(owner));
    const runs = await db
      .selectFrom('agent_runs')
      .select('agent_id')
      .where('id', 'in', started.length > 0 ? started : ['00000000-0000-0000-0000-000000000000'])
      .execute();
    const firedAgents = runs.map((run) => run.agent_id);
    expect(firedAgents).toContain(filtered);
    expect(firedAgents).not.toContain(other);
  });
});
