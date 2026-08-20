/**
 * The zoom/* event handlers: transcripts and AI Companion summaries into
 * the knowledge layer.
 *
 * Webhook payloads are routing hints (whose meeting, which uuid) — content
 * is always re-fetched from the API under the HOST's own grant, never
 * trusted from the delivery and never fetched with a shared credential.
 * The payload's download_token is deliberately unused: the transcript
 * endpoint hands back a download_url our Bearer token authorizes.
 *
 * refIds are `${hostEmail}/${uuid}/transcript` and `.../summary` — distinct
 * bases so re-ingesting one never clears the other's chunks, both owned by
 * the host for the pure ACL check.
 */

import { ZoomClient, vttToText, parseZoomWebhookPayload } from '@renkei/connector-zoom';
import { ZOOM } from '@renkei/provider-grants';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import { enqueueKnowledgeEvent } from '../enqueue';
import { publishDomainEvent, BODY_PREVIEW_CHARS } from '../domain-events';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveZoomHostAccess } from './zoom-access';
import { logger } from '../logger';

const COMPONENT = 'zoom/ingest';

/** Transcript chunks run larger than chat messages; keep speaker context. */
const TRANSCRIPT_CHUNKING = { maxChars: 4000, overlap: 400 };

interface ZoomEventFacts {
  hostId: string | null;
  hostEmail: string | null;
  meetingId: string | null;
  meetingUuid: string;
  topic: string;
  startTime: string;
}

function factsOf(event: ClaimedEvent): ZoomEventFacts {
  const parsed = parseZoomWebhookPayload(event.payload);
  if (!parsed.ok) throw new Error('zoom event payload does not parse');
  const { hostId, hostEmail, meetingId, meetingUuid, data } = parsed.val;
  const uuid = meetingUuid ?? (typeof data.meeting_uuid === 'string' ? data.meeting_uuid : null);
  if (!uuid) throw new Error('zoom event carries no meeting uuid');
  return {
    hostId: hostId ?? (typeof data.meeting_host_id === 'string' ? data.meeting_host_id : null),
    hostEmail:
      hostEmail ?? (typeof data.meeting_host_email === 'string' ? data.meeting_host_email : null),
    meetingId: meetingId ?? (typeof data.meeting_id === 'number' ? String(data.meeting_id) : null),
    meetingUuid: uuid,
    topic: typeof data.topic === 'string' ? data.topic : '',
    startTime: typeof data.start_time === 'string' ? data.start_time : '',
  };
}

export function createZoomTranscriptHandler(
  deps: { publish?: typeof publishDomainEvent } = {}
): EventHandler {
  const publish = deps.publish ?? publishDomainEvent;

  return async (event) => {
    const facts = factsOf(event);
    const tenantId = event.tenant_id;

    const access = await resolveZoomHostAccess(tenantId, facts.hostId, facts.hostEmail);
    if (!access) {
      // No grant means no owner subject either — nothing to ingest AND no
      // agents to fire under the owner-scoped fan-out rule.
      logger.info('host {hostEmail} has no zoom grant; transcript skipped', {
        component: COMPONENT,
        tenantId,
        hostEmail: facts.hostEmail ?? facts.hostId ?? '(unknown)',
      });
      return;
    }

    const client = new ZoomClient(access.accessToken);
    // The uuid names the exact occurrence; the transcript endpoint accepts it.
    const transcript = await client.getMeetingTranscript(facts.meetingUuid);
    if (!transcript.ok) {
      // NOT_FOUND right after transcript_completed is usually propagation
      // lag — throwing rides the retry/backoff budget, which fits.
      throw new Error(
        transcript.err.type === 'NOT_FOUND'
          ? `transcript not available yet for meeting ${facts.meetingUuid}`
          : `could not fetch transcript for meeting ${facts.meetingUuid}`
      );
    }
    const vtt = await client.downloadFromUrl(transcript.val.downloadUrl);
    if (!vtt.ok) throw new Error(`could not download transcript for ${facts.meetingUuid}`);
    const text = vttToText(vtt.val);
    if (!text.trim()) {
      logger.warn('transcript for {meetingUuid} was empty', {
        component: COMPONENT,
        tenantId,
        meetingUuid: facts.meetingUuid,
      });
    }

    // Knowledge indexing is optional (the embedder may be off, the text may
    // be empty) — agent triggers below fire regardless, so the embedder
    // check gates ONLY this enqueue.
    const embedder = await resolveEmbeddingProvider(tenantId);
    if (embedder && text.trim()) {
      // Embedding is deferred to the embedding queue (Decision #20): the
      // bounded Zoom fetch/download above stays here, the network-bound
      // chunk-and-embed does not.
      const refId = `${access.hostEmail}/${facts.meetingUuid}/transcript`;
      await enqueueKnowledgeEvent(
        tenantId,
        'ingest.object',
        {
          provider: ZOOM,
          refId,
          content: facts.topic ? `Meeting: ${facts.topic}\n\n${text}` : text,
          metadata: {
            kind: 'transcript',
            meetingId: facts.meetingId ?? undefined,
            meetingUuid: facts.meetingUuid,
            topic: facts.topic || undefined,
            startTime: facts.startTime || undefined,
            hostEmail: access.hostEmail,
          },
          sourceAt: facts.startTime || null,
          chunking: TRANSCRIPT_CHUNKING,
        },
        // Redeliveries of the same transcript stay serial; different meetings
        // embed in parallel.
        `zoom/${refId}`
      );
      logger.info('queued transcript for {meetingUuid} for indexing', {
        component: COMPONENT,
        tenantId,
        meetingUuid: facts.meetingUuid,
      });
    } else if (!embedder) {
      logger.info('knowledge layer off; transcript not indexed', {
        component: COMPONENT,
        tenantId,
      });
    }

    // The handler's LAST act (the retry contract in domain-events.ts): the
    // host's event-triggered agents fire even when knowledge is off or the
    // transcript came back empty — they refetch by id under their own grant.
    // `data` keys mirror the trigger catalog's provides, minus `trigger.`.
    if (!access.subject) return;
    await publish({
      tenantId,
      provider: 'zoom',
      type: 'recording.transcript_completed',
      ownerSubject: access.subject,
      data: {
        meetingId: facts.meetingId ?? '',
        meetingUuid: facts.meetingUuid,
        topic: facts.topic,
        hostEmail: access.hostEmail,
        startTime: facts.startTime,
        transcriptPreview: text.slice(0, BODY_PREVIEW_CHARS),
      },
      occurredAt: facts.startTime || undefined,
      orderingKey: `zoom/${tenantId}/${facts.meetingUuid}`,
    });
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createZoomSummaryHandler(
  deps: { publish?: typeof publishDomainEvent } = {}
): EventHandler {
  const publish = deps.publish ?? publishDomainEvent;

  return async (event) => {
    const facts = factsOf(event);
    const tenantId = event.tenant_id;

    const access = await resolveZoomHostAccess(tenantId, facts.hostId, facts.hostEmail);
    if (!access) {
      // No grant → no owner subject → no agents to fire either; skip whole.
      logger.info('host {hostEmail} has no zoom grant; summary skipped', {
        component: COMPONENT,
        tenantId,
        hostEmail: facts.hostEmail ?? facts.hostId ?? '(unknown)',
      });
      return;
    }

    if (!facts.meetingId) throw new Error('summary event carries no meeting id');
    const client = new ZoomClient(access.accessToken);
    const summary = await client.getMeetingSummary(facts.meetingId);
    if (!summary.ok) {
      throw new Error(
        summary.err.type === 'NOT_FOUND'
          ? `summary not available yet for meeting ${facts.meetingId}`
          : `could not fetch summary for meeting ${facts.meetingId}`
      );
    }

    const body = isRecord(summary.val) ? summary.val : {};
    const details = Array.isArray(body.summary_details)
      ? body.summary_details
          .filter(isRecord)
          .map((detail) => `${str(detail.label)}\n${str(detail.summary)}`.trim())
          .filter(Boolean)
          .join('\n\n')
      : '';
    const nextSteps = Array.isArray(body.next_steps)
      ? body.next_steps.filter((step): step is string => typeof step === 'string')
      : [];
    const text = [
      str(body.summary_title) || (facts.topic ? `Summary: ${facts.topic}` : ''),
      str(body.summary_overview),
      details,
      nextSteps.length ? `Next steps:\n${nextSteps.map((step) => `- ${step}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!text.trim()) {
      logger.warn('summary for {meetingId} carried no content', {
        component: COMPONENT,
        tenantId,
        meetingId: facts.meetingId,
      });
    }

    // As in the transcript handler: the embedder gates ONLY the knowledge
    // enqueue; the domain event below publishes regardless.
    const embedder = await resolveEmbeddingProvider(tenantId);
    if (embedder && text.trim()) {
      const refId = `${access.hostEmail}/${facts.meetingUuid}/summary`;
      await enqueueKnowledgeEvent(
        tenantId,
        'ingest.object',
        {
          provider: ZOOM,
          refId,
          content: text,
          metadata: {
            kind: 'summary',
            meetingId: facts.meetingId,
            meetingUuid: facts.meetingUuid,
            topic: facts.topic || undefined,
            startTime: facts.startTime || undefined,
            hostEmail: access.hostEmail,
          },
          sourceAt: facts.startTime || null,
        },
        `zoom/${refId}`
      );
      logger.info('queued AI summary for meeting {meetingId} for indexing', {
        component: COMPONENT,
        tenantId,
        meetingId: facts.meetingId,
      });
    } else if (!embedder) {
      logger.info('knowledge layer off; summary not indexed', { component: COMPONENT, tenantId });
    }

    // Last act — see the transcript handler. Keys mirror the catalog row.
    if (!access.subject) return;
    await publish({
      tenantId,
      provider: 'zoom',
      type: 'meeting.summary_completed',
      ownerSubject: access.subject,
      data: {
        meetingId: facts.meetingId,
        meetingUuid: facts.meetingUuid,
        topic: facts.topic,
        hostEmail: access.hostEmail,
        startTime: facts.startTime,
        summaryPreview: text.slice(0, BODY_PREVIEW_CHARS),
      },
      occurredAt: facts.startTime || undefined,
      orderingKey: `zoom/${tenantId}/${facts.meetingUuid}`,
    });
  };
}
