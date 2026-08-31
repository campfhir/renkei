/**
 * notifyAgentEdited's contract, same posture as agent-run-failed.test.ts:
 * NEVER fire a channel the owner's own effective preference (agent override,
 * else the general `agentEditedByOthers`) didn't ask for — App, Outlook, and
 * WebEx are each independently gated.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/notifications', () => ({ sendPush: jest.fn() }));
jest.mock('@renkei/user-prefs', () => ({
  ...jest.requireActual('@renkei/user-prefs'),
  getNotificationPrefs: jest.fn(),
}));
jest.mock('@renkei/connector-webex', () => ({
  WebexClient: jest.fn().mockImplementation(() => ({ sendNoteToSelf: jest.fn() })),
}));
jest.mock('@/lib/mcp-tools/graph/client', () => ({
  resolveGraphAccess: jest.fn(),
  graphPost: jest.fn(),
}));
jest.mock('@/lib/webex-user-access', () => ({ resolveWebexUserAccess: jest.fn() }));
jest.mock('@/lib/identity', () => ({ getIdentityDisplay: jest.fn() }));

const inserted: Record<string, unknown>[] = [];
let dbAvailable = true;

jest.mock('@renkei/db', () => ({
  getDatabase: () =>
    dbAvailable
      ? {
          ok: true,
          val: {
            insertInto: () => ({
              values: (row: Record<string, unknown>) => {
                inserted.push(row);
                return { execute: async () => [] };
              },
            }),
          },
        }
      : { ok: false },
}));

import { notifyAgentEdited } from './edit-notification';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs';

const { getNotificationPrefs: mockGetNotificationPrefs } = jest.requireMock<{
  getNotificationPrefs: jest.Mock;
}>('@renkei/user-prefs');
const { resolveGraphAccess: mockResolveGraphAccess, graphPost: mockGraphPost } = jest.requireMock<{
  resolveGraphAccess: jest.Mock;
  graphPost: jest.Mock;
}>('@/lib/mcp-tools/graph/client');
const { resolveWebexUserAccess: mockResolveWebexAccess } = jest.requireMock<{
  resolveWebexUserAccess: jest.Mock;
}>('@/lib/webex-user-access');
const { getIdentityDisplay: mockGetIdentityDisplay } = jest.requireMock<{
  getIdentityDisplay: jest.Mock;
}>('@/lib/identity');
const { WebexClient: MockWebexClient } = jest.requireMock<{ WebexClient: jest.Mock }>(
  '@renkei/connector-webex'
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

const TENANT_ID = 'tenant-1';
const OWNER_SUBJECT = 'owner-1';
const AGENT_ID = 'agent-1';

function prefs(
  agentEditedByOthers: Partial<NotificationPrefs['agentEditedByOthers']>,
  agentOverrides: NotificationPrefs['agentOverrides'] = {}
): NotificationPrefs {
  return {
    ...DEFAULT_NOTIFICATION_PREFS,
    agentEditedByOthers: { ...DEFAULT_NOTIFICATION_PREFS.agentEditedByOthers, ...agentEditedByOthers },
    agentOverrides,
  };
}

function edit(): void {
  notifyAgentEdited({
    tenantId: TENANT_ID,
    ownerSubject: OWNER_SUBJECT,
    actorSubject: 'editor-1',
    agentId: AGENT_ID,
    agentName: 'Sunday Sweep',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  inserted.length = 0;
  dbAvailable = true;
  mockGetIdentityDisplay.mockImplementation(async (_tenantId: string, subject: string) =>
    subject === OWNER_SUBJECT
      ? { email: 'owner@example.com', displayName: 'Owner' }
      : { email: 'editor@example.com', displayName: 'Editor' }
  );
  mockResolveGraphAccess.mockResolvedValue({
    accessToken: 'ms-token',
    upn: 'owner@example.com',
    accountId: 'ms-account-1',
  });
  mockGraphPost.mockResolvedValue({ ok: true, body: {} });
  mockResolveWebexAccess.mockResolvedValue({
    accountId: 'webex-account-1',
    accessToken: 'webex-token',
    metadata: {},
  });
});

describe('notifyAgentEdited', () => {
  it('sends nothing on any channel when every effective preference is off', async () => {
    mockGetNotificationPrefs.mockResolvedValue(
      prefs({ app: false, email: false, webex: false })
    );

    edit();
    await flush();

    expect(inserted).toHaveLength(0);
    expect(mockGraphPost).not.toHaveBeenCalled();
    expect(MockWebexClient).not.toHaveBeenCalled();
  });

  it('writes the App row when only App is wanted', async () => {
    mockGetNotificationPrefs.mockResolvedValue(
      prefs({ app: true, email: false, webex: false })
    );

    edit();
    await flush();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: 'agent_edited', agent_id: AGENT_ID });
    expect(String(inserted[0]?.headline)).toContain('Sunday Sweep');
    expect(mockGraphPost).not.toHaveBeenCalled();
    expect(MockWebexClient).not.toHaveBeenCalled();
  });

  it('sends only Outlook mail when only email is wanted', async () => {
    mockGetNotificationPrefs.mockResolvedValue(
      prefs({ app: false, email: true, webex: false })
    );

    edit();
    await flush();

    expect(inserted).toHaveLength(0);
    expect(mockGraphPost).toHaveBeenCalledTimes(1);
    expect(mockGraphPost.mock.calls[0][2]).toBe('/me/sendMail');
    expect(MockWebexClient).not.toHaveBeenCalled();
  });

  it('sends only a WebEx note when only webex is wanted', async () => {
    mockGetNotificationPrefs.mockResolvedValue(
      prefs({ app: false, email: false, webex: true })
    );
    const sendNoteToSelf = jest.fn().mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    edit();
    await flush();

    expect(inserted).toHaveLength(0);
    expect(mockGraphPost).not.toHaveBeenCalled();
    expect(MockWebexClient).toHaveBeenCalledWith('webex-token');
    expect(sendNoteToSelf).toHaveBeenCalledTimes(1);
    expect(String(sendNoteToSelf.mock.calls[0][0])).toContain('Sunday Sweep');
  });

  it("lets the agent's own override reach a channel the general preference has off", async () => {
    mockGetNotificationPrefs.mockResolvedValue(
      prefs(
        { app: false, email: false, webex: false },
        { [AGENT_ID]: { agentEditedByOthers: { app: false, email: true, webex: false } } }
      )
    );

    edit();
    await flush();

    expect(inserted).toHaveLength(0);
    expect(mockGraphPost).toHaveBeenCalledTimes(1);
    expect(MockWebexClient).not.toHaveBeenCalled();
  });

  it('never throws when a channel errors', async () => {
    mockGetNotificationPrefs.mockResolvedValue(
      prefs({ app: false, email: true, webex: true })
    );
    mockGraphPost.mockRejectedValue(new Error('graph is down'));
    const sendNoteToSelf = jest.fn().mockRejectedValue(new Error('webex is down'));
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    expect(() => edit()).not.toThrow();
    await flush();
  });
});
