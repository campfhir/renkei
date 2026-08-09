/**
 * @renkei/connector-zoom — the Zoom connector's ingress surface.
 *
 * Data contract (RENKEI.md, connector contract):
 * 1. Content stored: meeting transcripts (VTT flattened to text) and AI
 *    Companion summaries, fetched on webhook events; nothing else is
 *    persisted by this package.
 * 2. Metadata indexed: host id/email, meeting id and instance uuid,
 *    timestamps — whatever the webhook carries, stored on the event row.
 * 3. Retrieval-only: everything else (meeting details, users) stays live
 *    behind the API client.
 * 4. Sharing: v1 ACL is host-only — the meeting host owns the transcript
 *    (see verifier.ts); participant-based ACL is declared future work.
 * 5. verifyAccess: createZoomAccessVerifier, pure host-of-ref check.
 *
 * Unlike WebEx (bot credential), Zoom ingestion rides per-user OAuth grants
 * (provider-grants ZoomAdapter) plus the webhook's own download_token for
 * transcript fetches.
 */

/** The connector key used in connector_configs, capability descriptors, and event rows. */
export const ZOOM_CONNECTOR = 'zoom';

export {
  verifyZoomSignature,
  buildUrlValidationResponse,
  parseZoomWebhookPayload,
  urlValidationTokenOf,
  type ZoomWebhookEvent,
} from './webhook';
export { ZoomClient, encodeZoomMeetingId, type ZoomUser } from './client';
export { vttToText } from './vtt';
export { zoomRefId, hostOfZoomRefId, createZoomAccessVerifier } from './verifier';
