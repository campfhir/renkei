import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, PROJECT, at, projectRow } from '../chats/fixtures';

const fixture = {
  chat_projects: [
    projectRow({ id: PROJECT.annCode, owner_subject: ANN, name: 'sync-worker', kind: 'code' }),
    projectRow({ id: PROJECT.annChat, owner_subject: ANN, name: 'notes', kind: 'code' }),
  ],
  ci_health_checkins: [
    {
      project_id: PROJECT.annCode,
      environment: 'production',
      token_hash: 'a'.repeat(64),
      token_hint: 'x9k2',
      issued_by: 'ann',
      issued_at: at(10),
      status: 'healthy',
      message: null,
      version: '1.4.2',
      sent_at: at(20),
      received_at: at(21),
      interval_seconds: 300,
      checkins: 7,
    },
    {
      project_id: PROJECT.annCode,
      environment: 'dev',
      token_hash: 'b'.repeat(64),
      token_hint: 'q1w2',
      issued_by: 'ann',
      issued_at: at(11),
      status: null,
      message: null,
      version: null,
      sent_at: null,
      received_at: null,
      interval_seconds: null,
      checkins: 0,
    },
  ],
};

export const ciHealthScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciHealth.listForProject',
    name: 'a project’s environments with a token, by environment, and none for another',
    fixture,
    run: async (store) => [
      await store.ciHealth.listForProject(PROJECT.annCode),
      await store.ciHealth.listForProject(PROJECT.annChat),
    ],
  },
  {
    method: 'ciHealth.issueToken',
    name: 'a first token, and one in place of another that keeps the last check-in',
    fixture,
    run: async (store) => {
      await store.ciHealth.issueToken(PROJECT.annChat, 'production', {
        hash: 'c'.repeat(64),
        hint: 'new1',
        issuedBy: 'bob',
        at: at(40),
      });
      await store.ciHealth.issueToken(PROJECT.annCode, 'production', {
        hash: 'd'.repeat(64),
        hint: 'new2',
        issuedBy: 'bob',
        at: at(41),
      });
      const checkin = {
        status: 'healthy',
        message: null,
        version: null,
        sentAt: at(50),
        receivedAt: at(50),
        intervalSeconds: null,
      };
      return [
        await store.ciHealth.listForProject(PROJECT.annChat),
        await store.ciHealth.listForProject(PROJECT.annCode),
        // The token it replaced no longer checks in.
        await store.ciHealth.checkIn('a'.repeat(64), checkin),
      ];
    },
  },
  {
    method: 'ciHealth.revoke',
    name: 'takes the token and its check-in away, and says when there was none',
    fixture,
    run: async (store) => [
      await store.ciHealth.revoke(PROJECT.annCode, 'production'),
      await store.ciHealth.revoke(PROJECT.annCode, 'staging'),
      await store.ciHealth.listForProject(PROJECT.annCode),
    ],
  },
  {
    method: 'ciHealth.checkIn',
    name: 'records what the token’s application said, counts it, and knows no other token',
    fixture,
    run: async (store) => [
      await store.ciHealth.checkIn('b'.repeat(64), {
        status: 'starting',
        message: 'warming caches',
        version: '2.0.0',
        sentAt: at(60),
        receivedAt: at(61),
        intervalSeconds: 120,
      }),
      await store.ciHealth.checkIn('a'.repeat(64), {
        status: 'error',
        message: 'database unreachable',
        version: null,
        sentAt: at(62),
        receivedAt: at(62),
        intervalSeconds: null,
      }),
      await store.ciHealth.checkIn('e'.repeat(64), {
        status: 'healthy',
        message: null,
        version: null,
        sentAt: at(63),
        receivedAt: at(63),
        intervalSeconds: null,
      }),
      await store.ciHealth.listForProject(PROJECT.annCode),
    ],
  },
];
