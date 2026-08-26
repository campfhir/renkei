/**
 * Event → run fan-out against a real database (skipped without
 * DATABASE_URL). What must hold: only the event owner's enabled agents
 * fire, match filters filter, the event payload arrives as the run's
 * initial state, and the firing lock (agent_trigger_firings) makes a
 * repeated delivery of the SAME source event a no-op — that is the
 * multi-worker-process duplicate-run guard.
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
    options: {
      enabled?: boolean;
      match?: Record<string, string | string[]>;
      eventSource?: string;
      eventType?: string;
    } = {}
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
        event_source: options.eventSource ?? 'microsoft',
        event_type: options.eventType ?? 'mail.received',
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
    const { started } = await fanOutAgentEvents(db, queue.producer, mailEvent(owner));
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
    const { started } = await fanOutAgentEvents(db, queue.producer, mailEvent(owner));
    const runs = await db
      .selectFrom('agent_runs')
      .select('agent_id')
      .where('id', 'in', started.length > 0 ? started : ['00000000-0000-0000-0000-000000000000'])
      .execute();
    const firedAgents = runs.map((run) => run.agent_id);
    expect(firedAgents).toContain(filtered);
    expect(firedAgents).not.toContain(other);
  });

  /**
   * The negative direction, end to end. The unit tests in
   * packages/agents/src/trigger-filters.test.ts cover the matcher itself;
   * these prove the stored jsonb, the catalog lookup and the fan-out query
   * agree — a filter that fails to narrow here looks exactly like no filter,
   * and the run row is the only place that shows the difference.
   */
  async function firedAgentsFor(event: Parameters<typeof fanOutAgentEvents>[2]): Promise<string[]> {
    const queue = new InMemoryQueue();
    const { started } = await fanOutAgentEvents(db, queue.producer, event);
    if (started.length === 0) return [];
    const runs = await db
      .selectFrom('agent_runs')
      .select('agent_id')
      .where('id', 'in', started)
      .execute();
    return runs.map((run) => run.agent_id);
  }

  it('narrows mail to exact senders, and refuses the rest', async () => {
    const scoped = await seedEventAgent(owner, {
      match: { fromAddresses: ['reporter@customer.example', 'other@customer.example'] },
    });
    const fired = await firedAgentsFor(mailEvent(owner));
    expect(fired).toContain(scoped);

    const missed = await firedAgentsFor(
      mailEvent(owner, { from: 'stranger@customer.example', messageId: 'msg-miss-1' })
    );
    expect(missed).not.toContain(scoped);
  });

  it('narrows WebEx to chosen spaces, and refuses a third space', async () => {
    const webexEvent = (roomId: string, messageId: string) => ({
      tenantId,
      source: 'webex',
      type: 'message.received',
      ownerSubject: owner,
      payload: { text: 'hi', sender: 'bob@corp.example', roomId, messageId },
    });
    const scoped = await seedEventAgent(owner, {
      eventSource: 'webex',
      eventType: 'message.received',
      match: { roomIds: ['ROOM-A', 'ROOM-B'] },
    });

    expect(await firedAgentsFor(webexEvent('ROOM-A', 'wx-1'))).toContain(scoped);
    // The case the whole feature exists for: a message in a space nobody
    // opted into must cost no run and no model call.
    expect(await firedAgentsFor(webexEvent('ROOM-Z', 'wx-2'))).not.toContain(scoped);
  });

  it('fails closed when a constrained key is missing from the payload', async () => {
    const scoped = await seedEventAgent(owner, { match: { fromAddresses: ['a@b.example'] } });
    const fired = await firedAgentsFor(mailEvent(owner, { from: '', messageId: 'msg-nokey' }));
    expect(fired).not.toContain(scoped);
  });

  it('ignores an unknown filter id but still applies its siblings', async () => {
    // The rollback case, against a real row: deploy N-1 reading a filter
    // that deploy N wrote. Silencing the agent would be the worse outcome.
    const scoped = await seedEventAgent(owner, {
      match: { somethingNewer: 'x', subjectContains: 'PROJ-42' },
    });
    expect(await firedAgentsFor(mailEvent(owner, { messageId: 'msg-fwd-1' }))).toContain(scoped);
    expect(
      await firedAgentsFor(mailEvent(owner, { subject: 'Holiday party', messageId: 'msg-fwd-2' }))
    ).not.toContain(scoped);
  });

  it('fires a source event at most once per trigger, however often it is delivered', async () => {
    // A fresh owner so earlier tests' lingering agents cannot muddy counts.
    const soloOwner = `solo-${randomUUID().slice(0, 8)}`;
    await seedEventAgent(soloOwner);
    const queue = new InMemoryQueue();
    const messageId = `dup-${randomUUID()}`;
    const event = mailEvent(soloOwner, { messageId });

    const first = await fanOutAgentEvents(db, queue.producer, event);
    // The duplicate-webhook / replay case: same message, second delivery.
    const second = await fanOutAgentEvents(db, queue.producer, event);
    const fresh = await fanOutAgentEvents(
      db,
      queue.producer,
      mailEvent(soloOwner, { messageId: `fresh-${randomUUID()}` })
    );

    expect(first.started).toHaveLength(1);
    expect(second.started).toHaveLength(0);
    expect(fresh.started).toHaveLength(1);
    // A lost firing lock is not a filter — nothing turned this event away,
    // another delivery simply got there first.
    expect(second.filtered).toBe(0);

    // The winner's run is recorded on the firing row.
    const firing = await db
      .selectFrom('agent_trigger_firings')
      .select('run_id')
      .where('dedupe_key', '=', `msg:${messageId}`)
      .executeTakeFirstOrThrow();
    expect(firing.run_id).toBe(first.started[0]);
  });

  it('falls back to the delivery id, and without one does not lock at all', async () => {
    const soloOwner = `solo-${randomUUID().slice(0, 8)}`;
    await seedEventAgent(soloOwner);
    const queue = new InMemoryQueue();
    // No messageId/meetingUuid in the payload — the queue-row id is the key.
    const bare = (eventId?: string) => ({
      ...mailEvent(soloOwner, { messageId: '' }),
      eventId,
    });

    const deliveryId = randomUUID();
    expect((await fanOutAgentEvents(db, queue.producer, bare(deliveryId))).started).toHaveLength(1);
    expect((await fanOutAgentEvents(db, queue.producer, bare(deliveryId))).started).toHaveLength(0);

    // No key derivable anywhere → pre-lock behavior (fires every time).
    expect((await fanOutAgentEvents(db, queue.producer, bare(undefined))).started).toHaveLength(1);
    expect((await fanOutAgentEvents(db, queue.producer, bare(undefined))).started).toHaveLength(1);
  });

  it('fires zoom transcript-completed triggers with the payload as state', async () => {
    const zoomAgent = await seedEventAgent(owner, {
      eventSource: 'zoom',
      eventType: 'recording.transcript_completed',
    });

    const queue = new InMemoryQueue();
    const { started } = await fanOutAgentEvents(db, queue.producer, {
      tenantId,
      source: 'zoom',
      type: 'recording.transcript_completed',
      ownerSubject: owner,
      payload: {
        meetingId: '987654',
        meetingUuid: 'uuid-1==',
        topic: 'Weekly sync',
        hostEmail: 'host@example.com',
        startTime: '2026-08-20T15:00:00Z',
        transcriptPreview: 'Alice: hello there',
      },
    });
    expect(started).toHaveLength(1);

    const run = await db
      .selectFrom('agent_runs')
      .select(['agent_id', 'initial_state'])
      .where('id', '=', started[0])
      .executeTakeFirstOrThrow();
    expect(run.agent_id).toBe(zoomAgent);
    const state: { meetingUuid?: unknown } =
      typeof run.initial_state === 'object' &&
      run.initial_state !== null &&
      !Array.isArray(run.initial_state)
        ? run.initial_state
        : {};
    expect(state.meetingUuid).toBe('uuid-1==');
  });
});
