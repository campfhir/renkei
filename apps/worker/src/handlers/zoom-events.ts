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
import { resolveEmbeddingProvider, ingestObjectChunks } from '@renkei/knowledge';
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

export function createZoomTranscriptHandler(): EventHandler {
  return async (event) => {
    const facts = factsOf(event);
    const tenantId = event.tenant_id;

    const access = await resolveZoomHostAccess(tenantId, facts.hostId, facts.hostEmail);
    if (!access) {
      logger.info('host {hostEmail} has no zoom grant; transcript skipped', {
        component: COMPONENT,
        tenantId,
        hostEmail: facts.hostEmail ?? facts.hostId ?? '(unknown)',
      });
      return;
    }

    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) {
      logger.info('knowledge layer off; transcript not indexed', {
        component: COMPONENT,
        tenantId,
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
      return;
    }

    const refId = `${access.hostEmail}/${facts.meetingUuid}/transcript`;
    const ingested = await ingestObjectChunks(
      tenantId,
      embedder,
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
      },
      TRANSCRIPT_CHUNKING
    );
    // Logged, not thrown: a retry would re-download the whole transcript to
    // re-run an upsert that already absorbed whatever succeeded.
    if (!ingested.ok) {
      logger.warn('could not index transcript for {meetingUuid}', {
        component: COMPONENT,
        tenantId,
        meetingUuid: facts.meetingUuid,
      });
      return;
    }
    logger.info('indexed transcript for {meetingUuid} in {chunks} chunk(s)', {
      component: COMPONENT,
      tenantId,
      meetingUuid: facts.meetingUuid,
      chunks: ingested.val.chunks,
    });
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createZoomSummaryHandler(): EventHandler {
  return async (event) => {
    const facts = factsOf(event);
    const tenantId = event.tenant_id;

    const access = await resolveZoomHostAccess(tenantId, facts.hostId, facts.hostEmail);
    if (!access) {
      logger.info('host {hostEmail} has no zoom grant; summary skipped', {
        component: COMPONENT,
        tenantId,
        hostEmail: facts.hostEmail ?? facts.hostId ?? '(unknown)',
      });
      return;
    }

    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) {
      logger.info('knowledge layer off; summary not indexed', { component: COMPONENT, tenantId });
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
      return;
    }

    const refId = `${access.hostEmail}/${facts.meetingUuid}/summary`;
    const ingested = await ingestObjectChunks(tenantId, embedder, {
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
    });
    if (!ingested.ok) {
      logger.warn('could not index summary for {meetingId}', {
        component: COMPONENT,
        tenantId,
        meetingId: facts.meetingId,
      });
      return;
    }
    logger.info('indexed AI summary for meeting {meetingId}', {
      component: COMPONENT,
      tenantId,
      meetingId: facts.meetingId,
    });
  };
}
