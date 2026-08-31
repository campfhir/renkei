/**
 * The run.failed handler's contract, mostly negative: it must NEVER send
 * on a channel the owner's own Preferences didn't ask for, on either
 * Outlook or WebEx — the bug this handler used to have (an unconditional
 * Outlook mail on every failure, regardless of preference).
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/user-prefs', () => ({
  ...jest.requireActual('@renkei/user-prefs'),
  getNotificationPrefs: jest.fn(),
}));
jest.mock('@renkei/connector-microsoft', () => ({ graphRequest: jest.fn() }));
jest.mock('@renkei/connector-webex', () => ({
  WebexClient: jest.fn().mockImplementation(() => ({ sendNoteToSelf: jest.fn() })),
}));
jest.mock('./microsoft-access', () => ({ resolveMicrosoftAccess: jest.fn() }));
jest.mock('./webex-linked-user', () => ({ resolveWebexUserAccessBySubject: jest.fn() }));
jest.mock('./feed-url', () => ({ registrationUrl: jest.fn(async () => 'https://renkei.example.com') }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createAgentRunFailedHandler } from './agent-run-failed';
import type { ClaimedEvent } from '../queue';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getNotificationPrefs: mockGetNotificationPrefs } = jest.requireMock<{
  getNotificationPrefs: jest.Mock;
}>('@renkei/user-prefs');
const { graphRequest: mockGraphRequest } = jest.requireMock<{ graphRequest: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { WebexClient: MockWebexClient } = jest.requireMock<{ WebexClient: jest.Mock }>(
  '@renkei/connector-webex'
);
const { resolveMicrosoftAccess: mockResolveMicrosoftAccess } = jest.requireMock<{
  resolveMicrosoftAccess: jest.Mock;
}>('./microsoft-access');
const { resolveWebexUserAccessBySubject: mockResolveWebexAccess } = jest.requireMock<{
  resolveWebexUserAccessBySubject: jest.Mock;
}>('./webex-linked-user');

const TENANT_ID = 'tenant-1';
const OWNER_SUBJECT = 'owner-1';

/** Any `.select(...).where(...).where(...).executeTakeFirst()` chain resolves to `rows[table]`. */
function stubDb(rows: Record<string, unknown>): void {
  const builder = (table: string): unknown => ({
    select: () => builder(table),
    where: () => builder(table),
    executeTakeFirst: async () => rows[table],
  });
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: { selectFrom: (table: string) => builder(table) },
  });
}

function prefs(runFailed: Partial<NotificationPrefs['runFailed']>): NotificationPrefs {
  return {
    ...DEFAULT_NOTIFICATION_PREFS,
    runFailed: { ...DEFAULT_NOTIFICATION_PREFS.runFailed, ...runFailed },
  };
}

function event(): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: TENANT_ID,
    source: 'agents',
    type: 'run.failed',
    attempts: 1,
    payload: {
      runId: 'run-1',
      agentId: 'agent-1',
      ownerSubject: OWNER_SUBJECT,
      errorKind: 'step_failed',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stubDb({
    agents: { name: 'Sweep the queue' },
    agent_runs: { error: 'A step failed' },
    identities: { email: 'owner@example.com' },
    provider_grants: { provider_account_id: 'ms-account-1' },
  });
  mockResolveMicrosoftAccess.mockResolvedValue({ accessToken: 'ms-token' });
  mockResolveWebexAccess.mockResolvedValue({ accessToken: 'webex-token' });
  mockGraphRequest.mockResolvedValue({ ok: true });
});

describe('agent-run-failed handler', () => {
  it('sends neither channel when neither preference is on — no grant lookups either', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: false, webex: false }));

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(MockWebexClient).not.toHaveBeenCalled();
    expect(mockResolveMicrosoftAccess).not.toHaveBeenCalled();
    expect(mockResolveWebexAccess).not.toHaveBeenCalled();
  });

  it('sends only Outlook when only runFailed.email is on', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: true, webex: false }));

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).toHaveBeenCalledTimes(1);
    expect(mockGraphRequest.mock.calls[0][1]).toBe('/me/sendMail');
    expect(MockWebexClient).not.toHaveBeenCalled();
    expect(mockResolveWebexAccess).not.toHaveBeenCalled();
  });

  it('sends only WebEx when only runFailed.webex is on', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: false, webex: true }));
    const sendNoteToSelf = jest.fn().mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockResolveMicrosoftAccess).not.toHaveBeenCalled();
    expect(MockWebexClient).toHaveBeenCalledWith('webex-token');
    expect(sendNoteToSelf).toHaveBeenCalledTimes(1);
    expect(String(sendNoteToSelf.mock.calls[0][0])).toContain('Sweep the queue');
  });

  it('sends both when both preferences are on', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: true, webex: true }));
    const sendNoteToSelf = jest.fn().mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).toHaveBeenCalledTimes(1);
    expect(sendNoteToSelf).toHaveBeenCalledTimes(1);
  });

  it('never throws when a channel errors — the run page is the record either way', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: true, webex: true }));
    mockGraphRequest.mockRejectedValue(new Error('graph is down'));
    const sendNoteToSelf = jest.fn().mockRejectedValue(new Error('webex is down'));
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    await expect(createAgentRunFailedHandler()(event())).resolves.toBeUndefined();
  });

  it('lets the failing agent\'s own override reach WebEx even when the general preference is off', async () => {
    mockGetNotificationPrefs.mockResolvedValue({
      ...DEFAULT_NOTIFICATION_PREFS,
      runFailed: { app: true, email: false, webex: false },
      agentOverrides: {
        'agent-1': { runFailed: { app: true, email: false, webex: true } },
      },
    });
    const sendNoteToSelf = jest.fn().mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(sendNoteToSelf).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a DIFFERENT agent's override is on but this run's agent has none", async () => {
    mockGetNotificationPrefs.mockResolvedValue({
      ...DEFAULT_NOTIFICATION_PREFS,
      runFailed: { app: true, email: false, webex: false },
      agentOverrides: {
        'some-other-agent': { runFailed: { app: true, email: true, webex: true } },
      },
    });

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(MockWebexClient).not.toHaveBeenCalled();
  });
});
