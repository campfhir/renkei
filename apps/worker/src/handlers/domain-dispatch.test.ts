/**
 * The dispatch handler: domain events fan to their subscribers in a fixed
 * order — knowledge first (strict enqueue, safe to retry), agents second.
 * WebEx messages are the one knowledge-subscribed event; mail is agents-
 * only here because Microsoft's knowledge writes live in its sync round.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/queue', () => ({
  agentJobsQueue: jest.fn(() => ({ producer: { enqueue: jest.fn() } })),
}));
jest.mock('@renkei/agents/event-fanout', () => ({ fanOutAgentEvents: jest.fn() }));
jest.mock('../enqueue', () => ({ enqueueKnowledgeEvent: jest.fn() }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { ok } from '@campfhir/safe-functions/helpers';
import { createDomainDispatchHandler } from './domain-dispatch';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { logger: mockLogger } = jest.requireMock<{
  logger: { info: jest.Mock; debug: jest.Mock };
}>('../logger');
const { fanOutAgentEvents: mockFanOut } = jest.requireMock<{ fanOutAgentEvents: jest.Mock }>(
  '@renkei/agents/event-fanout'
);
const { enqueueKnowledgeEvent: mockEnqueueKnowledge } = jest.requireMock<{
  enqueueKnowledgeEvent: jest.Mock;
}>('../enqueue');

function webexEvent(): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'domain:webex',
    type: 'message.received',
    payload: {
      ownerSubject: 'auth0|watcher',
      provider: 'webex',
      data: {
        text: 'the message',
        sender: 'bob@example.com',
        roomId: 'room-1',
        messageId: 'msg-1',
      },
      occurredAt: '2026-08-16T09:00:00Z',
    },
    attempts: 1,
  };
}

function mailEvent(): ClaimedEvent {
  return {
    id: 'evt-2',
    tenant_id: 'tenant-1',
    source: 'domain:microsoft',
    type: 'mail.received',
    payload: {
      ownerSubject: 'auth0|owner',
      provider: 'microsoft',
      data: { subject: 'Hello', body: 'preview', from: 'carol@example.com', messageId: 'm-9' },
    },
    attempts: 1,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDatabase.mockReturnValue(ok({ fake: 'db' }));
  mockFanOut.mockResolvedValue({ started: [], filtered: 0 });
  mockEnqueueKnowledge.mockResolvedValue(undefined);
});

test('webex message: knowledge ingest enqueued strictly, then agents fan out', async () => {
  await createDomainDispatchHandler()(webexEvent());

  expect(mockEnqueueKnowledge).toHaveBeenCalledWith(
    'tenant-1',
    'ingest.object',
    expect.objectContaining({
      provider: 'webex',
      refId: 'room-1/msg-1',
      content: 'the message',
      metadata: expect.objectContaining({ kind: 'msg', roomId: 'room-1' }),
      sourceAt: '2026-08-16T09:00:00Z',
    }),
    'room-1/msg-1',
    { strict: true }
  );
  expect(mockFanOut).toHaveBeenCalledWith(
    { fake: 'db' },
    expect.anything(),
    expect.objectContaining({
      tenantId: 'tenant-1',
      source: 'webex',
      type: 'message.received',
      ownerSubject: 'auth0|watcher',
      payload: expect.objectContaining({ text: 'the message', roomId: 'room-1' }),
    })
  );
  // Ordering matters: a knowledge failure must throw BEFORE any run starts.
  expect(mockEnqueueKnowledge.mock.invocationCallOrder[0]).toBeLessThan(
    mockFanOut.mock.invocationCallOrder[0]
  );
});

test('mail: no knowledge subscriber, agents still fan out', async () => {
  await createDomainDispatchHandler()(mailEvent());
  expect(mockEnqueueKnowledge).not.toHaveBeenCalled();
  expect(mockFanOut).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ source: 'microsoft', type: 'mail.received' })
  );
});

test('a failed knowledge enqueue throws before agents are consulted', async () => {
  mockEnqueueKnowledge.mockRejectedValue(new Error('queue down'));
  await expect(createDomainDispatchHandler()(webexEvent())).rejects.toThrow('queue down');
  expect(mockFanOut).not.toHaveBeenCalled();
});

test('a malformed payload throws into the retry path', async () => {
  const event = webexEvent();
  event.payload = { provider: 'webex' };
  await expect(createDomainDispatchHandler()(event)).rejects.toThrow(/ownerSubject/);
});

/**
 * A filtered event used to vanish: no run row, and no line anywhere. That
 * makes "my agent didn't fire" unanswerable — a filter working exactly as
 * written and a filter that is quietly wrong look identical from outside.
 */
test('a trigger turned away by its own filters is logged as filtered', async () => {
  mockFanOut.mockResolvedValue({ started: [], filtered: 2 });
  await createDomainDispatchHandler()(webexEvent());

  const [message, fields] = mockLogger.info.mock.calls.at(-1) ?? [];
  expect(String(message)).toContain('filtered');
  expect(fields).toMatchObject({ count: 2, source: 'webex', type: 'message.received' });
});

test('an event nothing was listening for stays quiet', async () => {
  // The other half: no filter turned anything away, so there is nothing to
  // report and the log must not imply otherwise.
  mockFanOut.mockResolvedValue({ started: [], filtered: 0 });
  await createDomainDispatchHandler()(webexEvent());
  expect(mockLogger.info).not.toHaveBeenCalled();
});
