/**
 * The schedule sweep against a real database (skipped without
 * DATABASE_URL). The property that matters most: two sweeps racing the
 * same due trigger fire ONE run — the optimistic advance is the lock.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore, type AgentTriggerRecord } from '@renkei/db';
import { InMemoryQueue } from '@renkei/queue';
import type { AgentDefinition } from '@renkei/agents';
import { createScheduleSweep } from './schedule-sweep';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('schedule sweep', () => {
  jest.setTimeout(20_000);

  // Every suite run seeds under its own subject and ids, so nothing needs
  // deleting afterwards and a shared database never collides.
  const suiteId = randomUUID();
  const subject = `sched-subject-${suiteId.slice(0, 8)}`;

  const definition: AgentDefinition = { instructions: '## Goal\n\nReact to the email.', tools: [] };

  afterAll(async () => {
    await closeDataStore();
  });

  async function seedSchedule(
    // The default seeds the LEGACY single-recurrence shape on purpose: the
    // sweep must keep firing pre-042 rows during a rolling deploy.
    config: Record<string, unknown> = { recurrence: { every: 'hour' }, timezone: 'UTC' }
  ): Promise<{ agentId: string; triggerId: string }> {
    const store = getDataStore().agents;
    const agentId = randomUUID();
    await store.create({
      id: agentId,
      ownerSubject: subject,
      name: `sched-agent-${agentId.slice(0, 8)}`,
      instructions: definition.instructions,
      tools: definition.tools,
      llmModelId: null,
      enabled: true,
      guardrails: null,
      canAskQuestions: false,
      autoAcceptActions: false,
    });
    const triggerId = randomUUID();
    await store.applyTriggerChanges(agentId, {
      update: [],
      insert: [
        {
          id: triggerId,
          kind: 'schedule',
          eventSource: null,
          eventType: null,
          config: JSON.stringify(config),
          enabled: true,
          nextRunAt: new Date(Date.now() - 60_000),
        },
      ],
      remove: [],
    });
    return { agentId, triggerId };
  }

  const runsOf = (agentId: string) =>
    getDataStore().agentRuns.list({
      agentId,
      ownerSubject: subject,
      audience: 'owner',
      limit: 100,
    });

  async function triggerOf(agentId: string, triggerId: string): Promise<AgentTriggerRecord> {
    const trigger = (await getDataStore().agents.listTriggers(agentId)).find(
      (row) => row.id === triggerId
    );
    if (!trigger) throw new Error(`no trigger ${triggerId}`);
    return trigger;
  }

  it('fires a due trigger once, advances it, and enqueues the run', async () => {
    const { agentId, triggerId } = await seedSchedule();
    const queue = new InMemoryQueue();
    await createScheduleSweep(queue.producer)();

    const runs = await runsOf(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerKind).toBe('schedule');

    const trigger = await triggerOf(agentId, triggerId);
    expect(trigger.nextRunAt && trigger.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(trigger.lastFiredAt).not.toBeNull();
    expect(trigger.lastError).toBeNull();
  });

  it('two racing sweeps fire exactly one run', async () => {
    const { agentId } = await seedSchedule();
    const queue = new InMemoryQueue();
    // Both sweeps read the same due row before either advances it — the
    // worst-case interleaving two replicas can produce.
    await Promise.all([
      createScheduleSweep(queue.producer)(),
      createScheduleSweep(queue.producer)(),
    ]);

    expect(await runsOf(agentId)).toHaveLength(1);
  });

  it('fires a multi-rule schedule with an org calendar and advances to the union min', async () => {
    const calendarId = randomUUID();
    await getDataStore().scheduleCalendars.create({
      id: calendarId,
      name: `holidays-${calendarId.slice(0, 8)}`,
      dates: [{ annual: '12-25', label: 'Christmas' }],
    });
    const { agentId, triggerId } = await seedSchedule({
      recurrences: [{ every: 'hour' }, { every: 'day', at: '09:00' }],
      timezone: 'UTC',
      calendarId,
      blackoutPolicy: 'after',
    });
    const queue = new InMemoryQueue();
    await createScheduleSweep(queue.producer)();

    expect(await runsOf(agentId)).toHaveLength(1);

    const trigger = await triggerOf(agentId, triggerId);
    expect(trigger.enabled).toBe(true);
    const next = trigger.nextRunAt?.getTime() ?? 0;
    expect(next).toBeGreaterThan(Date.now());
    // The hourly rule wins the union: at most an hour out.
    expect(next).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
  });

  it('turns off a malformed schedule instead of erroring forever', async () => {
    const { agentId, triggerId } = await seedSchedule();
    const seeded = await triggerOf(agentId, triggerId);
    // A stored recurrence this build cannot read (say, a newer deploy's
    // shape), still due.
    await getDataStore().agents.applyTriggerChanges(agentId, {
      update: [
        {
          id: triggerId,
          eventSource: null,
          eventType: null,
          config: JSON.stringify({ recurrence: { every: 'never' } }),
          enabled: true,
          nextRunAt: seeded.nextRunAt,
        },
      ],
      insert: [],
      remove: [],
    });
    const queue = new InMemoryQueue();
    await createScheduleSweep(queue.producer)();

    const trigger = await triggerOf(agentId, triggerId);
    expect(trigger.enabled).toBe(false);
    expect(trigger.lastError).toContain('malformed');
  });
});
