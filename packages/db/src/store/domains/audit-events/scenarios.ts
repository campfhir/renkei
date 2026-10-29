import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-a${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const fixture = {
  identities: [
    { subject: 'ann', email: 'ann@example.test', display_name: 'Ann' },
    { subject: 'bob', email: 'bob@example.test', display_name: null },
  ],
  audit_events: [
    { id: id(1), actor_subject: 'ann', action: 'user.signed_in', created_at: at(1) },
    {
      id: id(2),
      actor_subject: 'bob',
      action: 'agent.created',
      target_kind: 'agent',
      target_label: 'Triage',
      details: { byAdmin: true, n: [1, 2] },
      created_at: at(3),
    },
    { id: id(3), actor_subject: null, action: 'settings.updated', created_at: at(3) },
    { id: id(4), actor_subject: 'ghost', action: 'user.signed_out', created_at: at(2) },
  ],
};

export const auditEventScenarios: Scenario<DataStore>[] = [
  {
    method: 'auditEvents.listRecent',
    name: 'newest first, ties by id desc, actor names joined, bounded',
    fixture,
    run: async (store) => [
      await store.auditEvents.listRecent(10),
      (await store.auditEvents.listRecent(2)).map((e) => e.id),
      await store.auditEvents.listRecent(0),
    ],
  },
  {
    method: 'auditEvents.listRecent',
    name: 'empty trail',
    run: (store) => store.auditEvents.listRecent(200),
  },
  {
    method: 'auditEvents.record',
    name: 'appends with details round-tripped',
    fixture,
    run: async (store) => {
      const event = {
        id: id(9),
        actorSubject: 'ann',
        action: 'connector.connected',
        targetKind: 'connector',
        targetLabel: 'microsoft',
        details: { subject: 'ann', nested: { ok: true } },
        createdAt: new Date(at(9)),
      };
      await store.auditEvents.record(event);
      await store.auditEvents.record({
        ...event,
        id: id(10),
        details: null,
        targetKind: null,
        targetLabel: null,
        createdAt: new Date(at(8)),
      });
      return { rows: await store.auditEvents.listRecent(3) };
    },
  },
  {
    method: 'auditEvents.listPlatformFor',
    name: "one resource's rows, newest first, ties by id desc; others invisible",
    fixture: {
      platform_audit_log: [
        {
          id: id(21),
          event_type: 'agent.disabled_by_admin',
          actor_id: 'ann',
          resource_id: 'r1',
          created_at: at(1),
        },
        {
          id: id(22),
          event_type: 'agent.enabled_by_admin',
          actor_id: 'ann',
          resource_id: 'r1',
          details: { n: 1 },
          created_at: at(2),
        },
        {
          id: id(23),
          event_type: 'agent.disabled_by_admin',
          actor_id: null,
          resource_id: 'r1',
          created_at: at(2),
        },
        {
          id: id(24),
          event_type: 'agent.disabled_by_admin',
          actor_id: 'bob',
          resource_id: 'r2',
          created_at: at(3),
        },
      ],
    },
    run: async (store) => [
      await store.auditEvents.listPlatformFor('r1'),
      await store.auditEvents.listPlatformFor('r9'),
    ],
  },
  {
    method: 'auditEvents.recordPlatform',
    name: 'appends with details round-tripped',
    run: async (store) => {
      const event = {
        id: id(31),
        eventType: 'agent.disabled_by_admin',
        actorId: 'ann',
        resourceId: 'r1',
        details: {},
      };
      await store.auditEvents.recordPlatform(event);
      await store.auditEvents.recordPlatform({
        ...event,
        id: id(32),
        details: null,
        actorId: null,
      });
      const rows = await store.auditEvents.listPlatformFor('r1');
      return {
        rows: rows
          .map(({ createdAt: _createdAt, ...row }) => row)
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      };
    },
  },
];
