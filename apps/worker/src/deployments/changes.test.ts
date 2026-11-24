/**
 * A deployment or health change, told: to the code project's owner and
 * everyone it is shared with who has a Bitbucket or GitHub connection, as
 * their Preferences say, and to their agents that listen for it.
 */

jest.mock('@renkei/user-prefs', () => {
  const actual = jest.requireActual<typeof import('@renkei/user-prefs/prefs')>(
    '@renkei/user-prefs/prefs'
  );
  return { ...actual, getNotificationPrefs: jest.fn() };
});
jest.mock('@renkei/notifications', () => ({ sendPush: jest.fn(async () => undefined) }));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
  loadKeyring: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
}));
jest.mock('@renkei/queue', () => ({
  agentJobsQueue: jest.fn(() => ({ producer: { enqueue: jest.fn() } })),
}));
jest.mock('@renkei/agents/event-fanout', () => ({
  fanOutAgentEvents: jest.fn(async () => ({ started: [], filtered: 0 })),
}));
jest.mock('../handlers/owner-channels', () => ({ deliverToOwnerChannels: jest.fn() }));
jest.mock('../handlers/feed-url', () => ({
  registrationUrl: jest.fn(async () => 'https://renkei.example.com'),
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs/prefs';
import { TRIGGER_EVENT_CATALOG } from '@renkei/agents';
import {
  changeVariables,
  type DeploymentChange,
  type DeploymentsChange,
  type HealthChanged,
} from '@renkei/ci-blocks';
import { announceChange, createDeploymentsChangeHandler } from './changes';
import type { ClaimedEvent } from '../queue';

const { getNotificationPrefs } = jest.requireMock<{ getNotificationPrefs: jest.Mock }>(
  '@renkei/user-prefs'
);
const { sendPush } = jest.requireMock<{ sendPush: jest.Mock }>('@renkei/notifications');
const { fanOutAgentEvents } = jest.requireMock<{ fanOutAgentEvents: jest.Mock }>(
  '@renkei/agents/event-fanout'
);
const { deliverToOwnerChannels } = jest.requireMock<{ deliverToOwnerChannels: jest.Mock }>(
  '../handlers/owner-channels'
);

const OWNER = 'auth0|owner';
const SHARED = 'auth0|shared';
const NO_HOST = 'auth0|no-host';
const AT = '2026-11-24T10:00:00.000Z';

/** Each person's settings; anyone not here has the defaults. */
let prefs: Record<string, Partial<NotificationPrefs>> = {};

async function connect(subject: string, provider: string): Promise<void> {
  await getDataStore().providerGrants.upsertSealed(provider, {
    accountId: `${provider}:${subject}`,
    clientId: 'client',
    displayName: subject,
    subject,
    encryptedAccessToken: 'sealed',
    encryptedRefreshToken: 'sealed',
    keepStoredRefreshToken: false,
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    requestedScopes: [],
    grantedScopes: null,
    metadata: {},
  });
}

/** A code project of the owner's, shared with two people, one of whom has no code host. */
async function project(): Promise<string> {
  const store = getDataStore();
  const id = await store.chatProjects.create({
    ownerSubject: OWNER,
    name: 'Shop',
    description: null,
    toolConfig: null,
    repo: { provider: 'atlassian-bitbucket', fullName: 'acme/shop', branch: 'main' },
  });
  for (const granteeSubject of [SHARED, NO_HOST]) {
    await store.resourceGrants.upsert({
      resourceKind: 'chat_project',
      resourceId: id,
      ownerSubject: OWNER,
      granteeSubject,
      role: 'editor',
      expiresAt: null,
    });
  }
  await connect(OWNER, 'atlassian-bitbucket');
  await connect(SHARED, 'github');
  return id;
}

const failedDeploy = (projectId: string): DeploymentChange => ({
  kind: 'deployment',
  projectId,
  environment: 'production',
  status: 'failed',
  deploymentId: 'd1',
  commit: '5c1d9e7af0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
  branch: 'main',
  runUrl: null,
  detail: 'exit code 1',
  at: AT,
});

const healthTo = (
  projectId: string,
  state: HealthChanged['state'],
  previous: string | null = 'healthy'
): HealthChanged => ({
  kind: 'health',
  projectId,
  environment: 'production',
  state,
  previous,
  missed: state === 'failed' ? 3 : 0,
  message: null,
  version: null,
  at: AT,
});

const rowsOf = async (subject: string) =>
  (await getDataStore().notifications.list(subject, { limit: 20 })).map((row) => ({
    kind: row.kind,
    headline: row.headline,
    refUrl: row.refUrl,
  }));

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  prefs = {};
  jest.clearAllMocks();
  getNotificationPrefs.mockImplementation(async (subject: string) => ({
    ...DEFAULT_NOTIFICATION_PREFS,
    ...prefs[subject],
  }));
});

afterEach(() => resetDataStore());

describe('who is told', () => {
  it('the owner and the people it is shared with — those with a code host connection', async () => {
    const id = await project();
    expect(await announceChange(failedDeploy(id))).toEqual({ people: 2, notified: 2, runs: 0 });
    expect(await rowsOf(OWNER)).toEqual([
      {
        kind: 'deployment_failed',
        headline: 'Deploying production of “Shop” failed',
        refUrl: `/code/${id}/environments?env=production`,
      },
    ]);
    expect(await rowsOf(SHARED)).toHaveLength(1);
    // Shared with, but neither Bitbucket nor GitHub connected.
    expect(await rowsOf(NO_HOST)).toEqual([]);
    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it('nobody, when the project has gone', async () => {
    expect(await announceChange(failedDeploy(randomUUID()))).toBeNull();
  });
});

describe('which changes notify, unless a person says otherwise', () => {
  const kindsFor = async (change: (id: string) => DeploymentsChange) => {
    const id = await project();
    await announceChange(change(id));
    return (await rowsOf(OWNER)).map((row) => row.kind);
  };

  it.each([
    ['failed', 'app_failed'],
    ['stopped', 'app_stopped'],
    ['error', 'app_unhealthy'],
    ['degraded', 'app_unhealthy'],
  ] as const)('an application that is %s does', async (state, kind) => {
    expect(await kindsFor((id) => healthTo(id, state))).toEqual([kind]);
  });

  it('a successful deployment, a late check-in and a recovery do not', async () => {
    expect(await kindsFor((id) => ({ ...failedDeploy(id), status: 'succeeded' }))).toEqual([]);
    expect(await kindsFor((id) => healthTo(id, 'late'))).toEqual([]);
    expect(await kindsFor((id) => healthTo(id, 'healthy', 'failed'))).toEqual([]);
  });

  it('a start, and an application saying it is starting, are nobody’s notification', async () => {
    expect(await kindsFor((id) => ({ ...failedDeploy(id), status: 'started' }))).toEqual([]);
    expect(await kindsFor((id) => healthTo(id, 'starting', null))).toEqual([]);
  });
});

describe('a person’s own settings', () => {
  it('switching failures off leaves that person alone, and nobody else', async () => {
    const id = await project();
    prefs[OWNER] = { deploymentFailed: { app: false, email: false, webex: false } };
    await announceChange(failedDeploy(id));
    expect(await rowsOf(OWNER)).toEqual([]);
    expect(await rowsOf(SHARED)).toHaveLength(1);
  });

  it('switching a quiet one on tells them', async () => {
    const id = await project();
    prefs[SHARED] = { appLate: { app: true, email: false, webex: false } };
    await announceChange(healthTo(id, 'late'));
    expect(await rowsOf(OWNER)).toEqual([]);
    expect(await rowsOf(SHARED)).toEqual([
      expect.objectContaining({
        kind: 'app_late',
        headline: 'production of “Shop” may be failing',
      }),
    ]);
  });

  it('Outlook and WebEx carry it when asked, with the link to the environment', async () => {
    const id = await project();
    prefs[OWNER] = { appFailed: { app: false, email: true, webex: true } };
    await announceChange(healthTo(id, 'failed'));
    expect(await rowsOf(OWNER)).toEqual([]);
    expect(deliverToOwnerChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerSubject: OWNER,
        email: true,
        webex: true,
        heading: 'production of “Shop” has stopped checking in',
        body: `It missed 3 check-ins in a row.\n\nOpen it: https://renkei.example.com/code/${id}/environments?env=production`,
      })
    );
  });
});

describe('their agents', () => {
  it('are offered every change — even one that notifies nobody — each person’s own', async () => {
    const id = await project();
    fanOutAgentEvents.mockResolvedValueOnce({ started: ['run-1'], filtered: 0 });
    const change: DeploymentChange = { ...failedDeploy(id), status: 'started' };
    expect(await announceChange(change)).toEqual({ people: 2, notified: 0, runs: 1 });
    expect(fanOutAgentEvents.mock.calls.map(([, event]) => event)).toEqual(
      [OWNER, SHARED].map((ownerSubject) => ({
        source: 'deployments',
        type: 'deployment.changed',
        ownerSubject,
        payload: changeVariables(change, { name: 'Shop', repository: 'acme/shop' }),
      }))
    );
  });

  it('one person who cannot be reached does not cost the others', async () => {
    const id = await project();
    fanOutAgentEvents.mockRejectedValueOnce(new Error('queue down'));
    await announceChange(healthTo(id, 'error'));
    expect(fanOutAgentEvents).toHaveBeenCalledTimes(2);
    expect(await rowsOf(SHARED)).toHaveLength(1);
  });

  it('are handed exactly what the trigger catalog promises', () => {
    const provided = (id: string) =>
      (TRIGGER_EVENT_CATALOG.find((event) => event.id === id)?.provides ?? [])
        .map((entry) => entry.name.replace(/^trigger\./, ''))
        .sort();
    const project = { name: 'Shop', repository: 'acme/shop' };
    expect(Object.keys(changeVariables(failedDeploy('p'), project)).sort()).toEqual(
      provided('deployments/deployment.changed')
    );
    expect(Object.keys(changeVariables(healthTo('p', 'error'), project)).sort()).toEqual(
      provided('deployments/health.changed')
    );
  });
});

describe('off the queue', () => {
  const event = (payload: ClaimedEvent['payload']): ClaimedEvent => ({
    id: 'evt-1',
    source: 'deployments',
    type: 'health.changed',
    payload,
    attempts: 1,
  });

  it('a change is announced', async () => {
    const id = await project();
    await createDeploymentsChangeHandler()(event({ ...healthTo(id, 'failed') }));
    expect((await rowsOf(OWNER)).map((row) => row.kind)).toEqual(['app_failed']);
  });

  it('a change for a project that has gone is skipped, not retried', async () => {
    expect(
      await createDeploymentsChangeHandler()(event({ ...healthTo(randomUUID(), 'failed') }))
    ).toBe('skipped');
  });

  it('something that is not a change fails, to be looked at', async () => {
    await expect(createDeploymentsChangeHandler()(event({ kind: 'health' }))).rejects.toThrow(
      'not a deployment or health change'
    );
  });
});
