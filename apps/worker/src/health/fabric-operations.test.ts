/**
 * The Fabric operations sweep: it follows the definition fetches nobody is
 * watching, leaves a watched one to its page, and tells the owner once —
 * in the app and by push, by their preference — when one ends while they
 * are away.
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
jest.mock('../handlers/owner-channels', () => ({ deliverToOwnerChannels: jest.fn() }));
jest.mock('../handlers/feed-url', () => ({
  registrationUrl: jest.fn(async () => 'https://renkei.example.com'),
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Fabric itself: a fetcher answering from `replies`, in place of the person's grant.
const replies: Record<string, { status: number; body?: unknown }[]> = {};
const asked: string[] = [];
jest.mock('@renkei/connector-fabric', () => {
  const actual = jest.requireActual<typeof import('@renkei/connector-fabric')>(
    '@renkei/connector-fabric'
  );
  return {
    ...actual,
    fabricApiBase: () => 'https://fabric.test/v1',
    fabricGrantFetcher: () => async (url: string) => {
      const path = url.replace('https://fabric.test/v1', '');
      asked.push(path);
      const reply = replies[path]?.shift();
      return reply
        ? new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
            status: reply.status,
          })
        : new Response('{}', { status: 404 });
    },
  };
});

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DEFAULT_NOTIFICATION_PREFS } from '@renkei/user-prefs/prefs';
import { createFabricOperationsSweep, WATCH_WINDOW_MS } from './fabric-operations';

const { getNotificationPrefs } = jest.requireMock<{ getNotificationPrefs: jest.Mock }>(
  '@renkei/user-prefs'
);
const { sendPush } = jest.requireMock<{ sendPush: jest.Mock }>('@renkei/notifications');
const { deliverToOwnerChannels } = jest.requireMock<{ deliverToOwnerChannels: jest.Mock }>(
  '../handlers/owner-channels'
);

const NOW = new Date(Date.UTC(2026, 10, 17, 12, 0, 0));
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const definition = {
  definition: {
    parts: [
      { path: 'notebook-content.ipynb', payload: b64('{"cells":[]}'), payloadType: 'InlineBase64' },
    ],
  },
};

async function running(id: string, watchedAt: Date | null) {
  const store = getDataStore().fabricOperations;
  await store.insert({
    id,
    subject: 'auth0|dana',
    kind: 'notebook-definition',
    workspaceId: 'ws',
    workspaceName: 'Sales',
    itemId: 'nb',
    itemName: 'Load orders',
    format: 'ipynb',
    status: 'running',
    operationId: `op-${id}`,
    percentComplete: null,
    result: null,
    error: null,
    nextPollAt: new Date(NOW.getTime() - 1000),
    finishedAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
  });
  if (watchedAt) await store.markWatched('auth0|dana', id, watchedAt);
}

const ID_AWAY = '00000000-0000-4000-8000-000000000001';
const ID_WATCHED = '00000000-0000-4000-8000-000000000002';

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  getNotificationPrefs.mockResolvedValue(DEFAULT_NOTIFICATION_PREFS);
  sendPush.mockClear();
  deliverToOwnerChannels.mockClear();
  asked.length = 0;
  for (const key of Object.keys(replies)) delete replies[key];
});
afterEach(() => resetDataStore());

describe('the Fabric operations sweep', () => {
  it('finishes a fetch nobody watches and tells its owner, in the feed and by push, linking its page', async () => {
    await running(ID_AWAY, null);
    replies[`/operations/op-${ID_AWAY}`] = [{ status: 200, body: { status: 'Succeeded' } }];
    replies[`/operations/op-${ID_AWAY}/result`] = [{ status: 200, body: definition }];

    await createFabricOperationsSweep({ now: () => NOW })();

    const operation = await getDataStore().fabricOperations.find('auth0|dana', ID_AWAY);
    expect(operation).toMatchObject({ status: 'succeeded', notifiedAt: expect.any(Date) });
    const [notification] = await getDataStore().notifications.list('auth0|dana', { limit: 5 });
    expect(notification).toMatchObject({
      kind: 'fabric_definition_ready',
      connector: 'fabric',
      headline: 'The definition of the notebook “Load orders” is ready',
      refUrl: `/fabric/operations/${ID_AWAY}`,
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(deliverToOwnerChannels).not.toHaveBeenCalled();
  });

  it('leaves a fetch whose page is open to that page', async () => {
    await running(ID_WATCHED, new Date(NOW.getTime() - WATCH_WINDOW_MS / 2));
    await createFabricOperationsSweep({ now: () => NOW })();
    expect(asked).toEqual([]);
    expect((await getDataStore().fabricOperations.find('auth0|dana', ID_WATCHED))?.status).toBe(
      'running'
    );
  });

  it('keeps following one Fabric is still working on, quietly', async () => {
    await running(ID_AWAY, new Date(NOW.getTime() - WATCH_WINDOW_MS * 2));
    replies[`/operations/op-${ID_AWAY}`] = [
      { status: 200, body: { status: 'Running', percentComplete: 30 } },
    ];
    await createFabricOperationsSweep({ now: () => NOW })();
    expect(await getDataStore().fabricOperations.find('auth0|dana', ID_AWAY)).toMatchObject({
      status: 'running',
      percentComplete: 30,
    });
    expect(await getDataStore().notifications.list('auth0|dana', { limit: 5 })).toEqual([]);
  });

  it('a failure is news too, and Outlook carries it when the person asked for that', async () => {
    getNotificationPrefs.mockResolvedValue({
      ...DEFAULT_NOTIFICATION_PREFS,
      fabricDefinitionReady: { app: false, email: true, webex: false },
    });
    await running(ID_AWAY, null);
    replies[`/operations/op-${ID_AWAY}`] = [
      {
        status: 200,
        body: { status: 'Failed', error: { errorCode: 'X', message: 'Label blocks export' } },
      },
    ];
    await createFabricOperationsSweep({ now: () => NOW })();
    expect(await getDataStore().notifications.list('auth0|dana', { limit: 5 })).toEqual([]);
    expect(deliverToOwnerChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        email: true,
        webex: false,
        heading: 'Fabric could not give the definition of the notebook “Load orders”',
        body: `Label blocks export\n\nOpen it: https://renkei.example.com/fabric/operations/${ID_AWAY}`,
      })
    );
  });
});
