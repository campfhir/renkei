/**
 * Minimal Zoom API client, grant scoped. Live queries only — this
 * connector persists nothing itself.
 *
 * The credential is an `AuthedFetch` (@renkei/delegate-client): the
 * delegate worker holds the token and attaches the Authorization header,
 * refreshes it and retries a 401, so nothing here sees a token or sets a
 * Bearer of its own. Zoom access arrives two ways — a per-user grant, or a
 * webhook's short-lived download_token — and both reach this client as a
 * fetcher built by whoever holds the credential.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { AuthedFetch } from '@renkei/delegate-client';
import { LaneLimiter, type RequestLane } from '@renkei/rate-limit';

const API_BASE = 'https://api.zoom.us/v2';
/**
 * Bounds every call out to Zoom — see the identical comment in
 * connector-webex's client.ts. A transcript/recording download can
 * legitimately take longer than an API call, so it gets its own, longer
 * bound rather than sharing this one.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Process-scoped, split by lane — see `LaneLimiter` in @renkei/rate-limit.
 *
 * Background absorbs webhook floods and sweeps; interactive keeps a reserve
 * for work a person is waiting on, so a burst of ingestion cannot push a
 * live ACL check past the retrieval gate's budget and turn allowed results
 * into withheld ones.
 *
 * One pair for both API calls and downloads: both count against the same
 * Zoom app's rate limit.
 */
const limiter = new LaneLimiter({
  interactive: { capacity: 20, refillPerSecond: 10 },
  background: { capacity: 5, refillPerSecond: 5 },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Encode a meeting id or uuid for a Zoom API path. Per Zoom's docs, a
 * meeting UUID that begins with '/' or contains '//' must be DOUBLE
 * URL-encoded, or Zoom's routing layer misparses the path and answers 404
 * for a meeting that exists. Plain numeric ids need no encoding; every
 * other uuid is single-encoded (they may contain '=', '+', etc.).
 */
export function encodeZoomMeetingId(idOrUuid: string): string {
  if (/^\d+$/.test(idOrUuid)) return idOrUuid;
  if (idOrUuid.startsWith('/') || idOrUuid.includes('//')) {
    return encodeURIComponent(encodeURIComponent(idOrUuid));
  }
  return encodeURIComponent(idOrUuid);
}

export interface ZoomUser {
  id: string;
  email: string;
  displayName: string | null;
  accountId: string | null;
}

export class ZoomClient {
  /** Set at construction, where the caller knows whether a person is waiting. */
  private readonly lane: RequestLane;

  constructor(
    private readonly auth: AuthedFetch,
    options?: { lane?: RequestLane }
  ) {
    this.lane = options?.lane ?? 'background';
  }

  private async get(
    path: string
  ): Promise<Result<Record<string, unknown>, 'ZOOM_API_ERROR' | 'NOT_FOUND'>> {
    await limiter.take(this.lane);
    let response: Response;
    try {
      response = await this.auth(`${API_BASE}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('ZOOM_API_ERROR' as const, {
        message: timedOut
          ? `Zoom API timed out after ${REQUEST_TIMEOUT_MS}ms for ${path}`
          : 'Zoom API unreachable',
      });
    }

    if (response.status === 404) return err('NOT_FOUND' as const);
    if (!response.ok) {
      // Zoom's own {code, message} names the cause — "Invalid access token,
      // does not contain scopes:[...]" beats a bare status every time.
      const bodyText = await response.text().catch(() => '');
      let detail = '';
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message) {
          detail = ` — Zoom said: "${parsed.message}"${
            typeof parsed.code === 'number' ? ` (code ${parsed.code})` : ''
          }`;
        }
      } catch {
        // non-JSON body; the status alone will have to do
      }
      return err('ZOOM_API_ERROR' as const, {
        message: `Zoom API ${response.status} for ${path}${detail}`,
      });
    }

    const parsed: unknown = await response.json().catch(() => null);
    if (!isRecord(parsed)) {
      return err('ZOOM_API_ERROR' as const, { message: `Zoom API returned no JSON for ${path}` });
    }
    return ok(parsed);
  }

  /**
   * Where a meeting's transcript can be downloaded from. 404 is a distinct
   * outcome, not an error: transcripts lag the recording by minutes and never
   * exist at all for meetings without cloud recording, so callers retry or
   * skip rather than alarm.
   */
  async getMeetingTranscript(
    meetingIdOrUuid: string
  ): Promise<Result<{ downloadUrl: string }, 'ZOOM_API_ERROR' | 'NOT_FOUND'>> {
    const result = await this.get(`/meetings/${encodeZoomMeetingId(meetingIdOrUuid)}/transcript`);
    if (!result.ok) return result;

    const downloadUrl =
      optionalString(result.val.download_url) ?? optionalString(result.val.downloadUrl);
    if (!downloadUrl) {
      return err('ZOOM_API_ERROR' as const, {
        message: 'transcript response missing download_url',
      });
    }
    return ok({ downloadUrl });
  }

  /**
   * Fetch the body behind a Zoom download URL (transcript VTT, etc.) through
   * the grant's fetcher. Zoom's download hosts want the credential in the
   * header, not a query parameter — the delegate attaches it — so this stays
   * in the client rather than being a bare fetch at the call site.
   */
  async downloadFromUrl(url: string): Promise<Result<string, 'ZOOM_API_ERROR'>> {
    await limiter.take(this.lane);
    let response: Response;
    try {
      response = await this.auth(url, {
        method: 'GET',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('ZOOM_API_ERROR' as const, {
        message: timedOut
          ? `Zoom download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`
          : 'Zoom download host unreachable',
      });
    }

    if (!response.ok) {
      return err('ZOOM_API_ERROR' as const, {
        message: `Zoom download failed (${response.status})`,
      });
    }
    const text = await response.text().catch(() => null);
    if (text === null) {
      return err('ZOOM_API_ERROR' as const, { message: 'Zoom download body unreadable' });
    }
    return ok(text);
  }

  /**
   * The AI Companion meeting summary. Returned as-is (unknown): Zoom is still
   * reshaping this payload release to release, so the caller decides what to
   * trust from it. 404 = no summary (feature off, or not generated yet).
   */
  async getMeetingSummary(
    meetingId: string
  ): Promise<Result<unknown, 'ZOOM_API_ERROR' | 'NOT_FOUND'>> {
    const result = await this.get(`/meetings/${encodeZoomMeetingId(meetingId)}/meeting_summary`);
    if (!result.ok) return result;
    return ok(result.val);
  }

  /** The token's own identity — how a grant is labeled and its host email learned. */
  async getMe(): Promise<Result<ZoomUser, 'ZOOM_API_ERROR'>> {
    const result = await this.get('/users/me');
    if (!result.ok) {
      // /users/me always exists for a live token; a 404 here is an API
      // failure, not a missing resource.
      return err('ZOOM_API_ERROR' as const, { message: 'users/me lookup failed' });
    }
    const body = result.val;

    const id = optionalString(body.id);
    const email = optionalString(body.email);
    if (!id || !email) {
      return err('ZOOM_API_ERROR' as const, { message: 'users/me response missing id/email' });
    }

    const first = optionalString(body.first_name);
    const last = optionalString(body.last_name);
    const composed = [first, last].filter((part) => part).join(' ');

    return ok({
      id,
      email,
      displayName: optionalString(body.display_name) ?? (composed || null),
      accountId: optionalString(body.account_id),
    });
  }
}
