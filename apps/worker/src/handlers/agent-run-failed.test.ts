/**
 * The run.failed handler's contract, mostly negative: it must NEVER send
 * on a channel the owner's own Preferences didn't ask for, on either
 * Outlook or WebEx — the bug this handler used to have (an unconditional
 * Outlook mail on every failure, regardless of preference).
 */

jest.mock('@renkei/user-prefs', () => ({
  ...jest.requireActual('@renkei/user-prefs'),
  getNotificationPrefs: jest.fn(),
}));
jest.mock('@renkei/connector-microsoft', () => ({ graphRequest: jest.fn() }));
jest.mock('@renkei/connector-webex', () => ({
  ...jest.requireActual('@renkei/connector-webex'),
  WebexClient: jest.fn().mockImplementation(() => ({ sendNoteToSelf: jest.fn() })),
}));
jest.mock('./microsoft-access', () => ({ resolveMicrosoftAccess: jest.fn() }));
jest.mock('./webex-linked-user', () => ({ resolveWebexUserAccessBySubject: jest.fn() }));
// No org bot here: the note goes to the solo space with the owner's token.
jest.mock('./webex-bot', () => ({ webexBotClient: jest.fn(async () => null) }));
jest.mock('./feed-url', () => ({
  registrationUrl: jest.fn(async () => 'https://renkei.example.com'),
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { authedFetch } from '@renkei/delegate-client';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createAgentRunFailedHandler } from './agent-run-failed';
import type { ClaimedEvent } from '../queue';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs';

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
const OWNER_SUBJECT = 'owner-1';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';

/** The agent, its failed run, and the owner's identity and Outlook grant, in a memory store. */
async function seedStore(): Promise<void> {
  const store = createMemoryDataStore();
  registerDataStore(store);
  await store.seed({
    identities: [{ subject: OWNER_SUBJECT, email: 'owner@example.com' }],
    agents: [{ id: AGENT_ID, name: 'Sweep the queue', owner_subject: OWNER_SUBJECT }],
    agent_runs: [
      {
        id: RUN_ID,
        agent_id: AGENT_ID,
        owner_subject: OWNER_SUBJECT,
        trigger_kind: 'manual',
        status: 'failed',
        error: 'A step failed',
      },
    ],
    provider_grants: [
      {
        provider: 'microsoft',
        provider_account_id: 'ms-account-1',
        client_id: 'client',
        display_name: 'Owner',
        subject: OWNER_SUBJECT,
        encrypted_access_token: 'sealed-a',
        encrypted_refresh_token: 'sealed-r',
        expires_at: new Date('2030-01-01T00:00:00.000Z'),
      },
    ],
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
    source: 'agents',
    type: 'run.failed',
    attempts: 1,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      ownerSubject: OWNER_SUBJECT,
      errorKind: 'step_failed',
    },
  };
}

afterEach(() => {
  resetDataStore();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await seedStore();
  mockResolveMicrosoftAccess.mockResolvedValue({ accessToken: 'ms-token' });
  mockResolveWebexAccess.mockResolvedValue({
    auth: webexAuth,
    personEmail: null,
    subject: 'alice',
  });
  mockGraphRequest.mockResolvedValue({ ok: true });
});

// The person's WebEx grant as the delegate hands it out: a fetcher, never a token.
const webexAuth = authedFetch(async () => new Response(), 'webex:tenant-1:alice');

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
    expect(mockResolveMicrosoftAccess).toHaveBeenCalledWith('ms-account-1');
    const mail = JSON.parse(String(mockGraphRequest.mock.calls[0][2].body));
    expect(mail.message.toRecipients).toEqual([{ emailAddress: { address: 'owner@example.com' } }]);
    expect(mail.message.body.content).toContain('A step failed');
    expect(MockWebexClient).not.toHaveBeenCalled();
    expect(mockResolveWebexAccess).not.toHaveBeenCalled();
  });

  it('sends only WebEx when only runFailed.webex is on', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: false, webex: true }));
    const sendNoteToSelf = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    await createAgentRunFailedHandler()(event());

    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockResolveMicrosoftAccess).not.toHaveBeenCalled();
    expect(MockWebexClient).toHaveBeenCalledWith(webexAuth);
    expect(sendNoteToSelf).toHaveBeenCalledTimes(1);
    expect(String(sendNoteToSelf.mock.calls[0][0])).toContain('Sweep the queue');
  });

  it('sends both when both preferences are on', async () => {
    mockGetNotificationPrefs.mockResolvedValue(prefs({ email: true, webex: true }));
    const sendNoteToSelf = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
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

  it("lets the failing agent's own override reach WebEx even when the general preference is off", async () => {
    mockGetNotificationPrefs.mockResolvedValue({
      ...DEFAULT_NOTIFICATION_PREFS,
      runFailed: { app: true, email: false, webex: false },
      agentOverrides: {
        [AGENT_ID]: { runFailed: { app: true, email: false, webex: true } },
      },
    });
    const sendNoteToSelf = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'm1', roomId: 'r1' } });
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
