/**
 * The zoom handlers' domain-event contract: every processed delivery ends
 * by publishing a domain event whose data keys are EXACTLY the trigger
 * catalog's provides (minus the `trigger.` prefix) — and that publish must
 * not depend on the knowledge layer being on. The catalog is imported and
 * compared directly so the promise stays executable, not conventional.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/provider-grants', () => ({ ZOOM: 'zoom' }));
jest.mock('../domain-events', () => ({
  publishDomainEvent: jest.fn(),
  BODY_PREVIEW_CHARS: 1_024,
}));
jest.mock('./zoom-access', () => ({ resolveZoomHostAccess: jest.fn() }));
jest.mock('@renkei/connector-zoom', () => ({
  ZoomClient: jest.fn(),
  vttToText: jest.fn(),
  parseZoomWebhookPayload: jest.requireActual('@renkei/connector-zoom').parseZoomWebhookPayload,
}));
jest.mock('@renkei/knowledge', () => ({ resolveEmbeddingProvider: jest.fn() }));
jest.mock('../enqueue', () => ({ enqueueKnowledgeEvent: jest.fn() }));

import { ok } from '@campfhir/safe-functions/helpers';
import { TRIGGER_EVENT_CATALOG } from '@renkei/agents';
import { createZoomTranscriptHandler, createZoomSummaryHandler } from './zoom-events';
import type { ClaimedEvent } from '../queue';

const { resolveZoomHostAccess: mockResolveAccess } = jest.requireMock<{
  resolveZoomHostAccess: jest.Mock;
}>('./zoom-access');
const { ZoomClient: MockZoomClient, vttToText: mockVttToText } = jest.requireMock<{
  ZoomClient: jest.Mock;
  vttToText: jest.Mock;
}>('@renkei/connector-zoom');
const { resolveEmbeddingProvider: mockResolveEmbeddingProvider } = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
}>('@renkei/knowledge');
const { enqueueKnowledgeEvent: mockEnqueueKnowledgeEvent } = jest.requireMock<{
  enqueueKnowledgeEvent: jest.Mock;
}>('../enqueue');

function claimedEvent(type: string): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'zoom',
    type,
    payload: {
      event: type,
      payload: {
        object: {
          id: 987654,
          uuid: 'uuid-1==',
          host_id: 'host-1',
          host_email: 'host@example.com',
          topic: 'Weekly sync',
          start_time: '2026-08-20T15:00:00Z',
        },
      },
    },
    attempts: 1,
  };
}

/** Catalog provides for one event id, without the `trigger.` prefix. */
function catalogKeys(eventId: string): string[] {
  const entry = TRIGGER_EVENT_CATALOG.find((event) => event.id === eventId);
  if (!entry) throw new Error(`catalog is missing ${eventId}`);
  return entry.provides.map((variable) => variable.name.replace(/^trigger\./, '')).sort();
}

beforeEach(() => {
  jest.resetAllMocks();
  mockResolveAccess.mockResolvedValue({
    accessToken: 'token',
    accountId: 'host-1',
    hostEmail: 'host@example.com',
    subject: 'subject-1',
  });
  mockResolveEmbeddingProvider.mockResolvedValue({ embed: jest.fn() });
  MockZoomClient.mockImplementation(() => ({
    getMeetingTranscript: jest.fn().mockResolvedValue(ok({ downloadUrl: 'https://dl' })),
    downloadFromUrl: jest.fn().mockResolvedValue(ok('WEBVTT')),
    getMeetingSummary: jest.fn().mockResolvedValue(
      ok({
        summary_title: 'Weekly sync',
        summary_overview: 'We talked.',
        summary_details: [],
        next_steps: [],
      })
    ),
  }));
  mockVttToText.mockReturnValue('Alice: hello there');
  mockEnqueueKnowledgeEvent.mockResolvedValue(undefined);
});

describe('createZoomTranscriptHandler', () => {
  it('publishes a domain event whose data keys match the catalog provides', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    await createZoomTranscriptHandler({ publish })(
      claimedEvent('recording.transcript_completed')
    );

    expect(publish).toHaveBeenCalledTimes(1);
    const published = publish.mock.calls[0][0];
    expect(published.provider).toBe('zoom');
    expect(published.type).toBe('recording.transcript_completed');
    expect(published.ownerSubject).toBe('subject-1');
    expect(Object.keys(published.data).sort()).toEqual(
      catalogKeys('zoom/recording.transcript_completed')
    );
    expect(published.data.transcriptPreview).toBe('Alice: hello there');
    expect(mockEnqueueKnowledgeEvent).toHaveBeenCalledTimes(1);
  });

  it('still publishes when the knowledge layer is off', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    const publish = jest.fn().mockResolvedValue(undefined);
    await createZoomTranscriptHandler({ publish })(
      claimedEvent('recording.transcript_completed')
    );

    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('skips entirely when the host has no grant', async () => {
    mockResolveAccess.mockResolvedValue(null);
    const publish = jest.fn();
    await createZoomTranscriptHandler({ publish })(
      claimedEvent('recording.transcript_completed')
    );

    expect(publish).not.toHaveBeenCalled();
    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
  });
});

describe('createZoomSummaryHandler', () => {
  it('publishes a domain event whose data keys match the catalog provides', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    await createZoomSummaryHandler({ publish })(claimedEvent('meeting.summary_completed'));

    expect(publish).toHaveBeenCalledTimes(1);
    const published = publish.mock.calls[0][0];
    expect(published.type).toBe('meeting.summary_completed');
    expect(Object.keys(published.data).sort()).toEqual(
      catalogKeys('zoom/meeting.summary_completed')
    );
    expect(String(published.data.summaryPreview)).toContain('We talked.');
  });

  it('still publishes when the knowledge layer is off', async () => {
    mockResolveEmbeddingProvider.mockResolvedValue(null);
    const publish = jest.fn().mockResolvedValue(undefined);
    await createZoomSummaryHandler({ publish })(claimedEvent('meeting.summary_completed'));

    expect(mockEnqueueKnowledgeEvent).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
