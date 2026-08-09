/**
 * Minimal Zoom API client, access-token scoped. Live queries only — this
 * connector persists nothing itself.
 *
 * The token is a parameter, not a fetch, because Zoom access arrives two
 * ways: a per-user grant's access token (provider-grants ZoomAdapter) or a
 * webhook's short-lived download_token. Both are just Bearer credentials
 * here.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const API_BASE = 'https://api.zoom.us/v2';

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
  constructor(private readonly accessToken: string) {}

  private async get(
    path: string
  ): Promise<Result<Record<string, unknown>, 'ZOOM_API_ERROR' | 'NOT_FOUND'>> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch {
      return err('ZOOM_API_ERROR' as const, { message: 'Zoom API unreachable' });
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
   * Fetch the body behind a Zoom download URL (transcript VTT, etc.) with the
   * Bearer credential. Zoom's download hosts want the token in the header,
   * not a query parameter, so this stays in the client rather than being a
   * bare fetch at the call site.
   */
  async downloadFromUrl(url: string): Promise<Result<string, 'ZOOM_API_ERROR'>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      return err('ZOOM_API_ERROR' as const, { message: 'Zoom download host unreachable' });
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
