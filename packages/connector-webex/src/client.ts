/**
 * Minimal WebEx API client, bot-token scoped. Live queries only — this
 * connector persists nothing itself (see the data contract in index.ts).
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const API_BASE = 'https://webexapis.com/v1';

export interface WebexMessage {
  id: string;
  roomId: string;
  roomType: string | null;
  text: string | null;
  personId: string | null;
  personEmail: string | null;
  created: string | null;
}

export interface WebexPerson {
  id: string;
  emails: string[];
  displayName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class WebexClient {
  constructor(private readonly botToken: string) {}

  private async get(path: string): Promise<Result<Record<string, unknown>, 'WEBEX_API_ERROR'>> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.botToken}`, Accept: 'application/json' },
      });
    } catch {
      return err('WEBEX_API_ERROR' as const, { message: 'WebEx API unreachable' });
    }

    if (!response.ok) {
      return err('WEBEX_API_ERROR' as const, {
        message: `WebEx API ${response.status} for ${path}`,
      });
    }

    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) {
      return err('WEBEX_API_ERROR' as const, { message: `WebEx API returned no JSON for ${path}` });
    }
    return ok(body);
  }

  /** Fetch a message's content — webhooks carry only its id. */
  async getMessage(messageId: string): Promise<Result<WebexMessage, 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/messages/${encodeURIComponent(messageId)}`);
    if (!result.ok) return result;
    const body = result.val;

    const id = optionalString(body.id);
    const roomId = optionalString(body.roomId);
    if (!id || !roomId) {
      return err('WEBEX_API_ERROR' as const, { message: 'message response missing id/roomId' });
    }

    return ok({
      id,
      roomId,
      roomType: optionalString(body.roomType),
      text: optionalString(body.text),
      personId: optionalString(body.personId),
      personEmail: optionalString(body.personEmail),
      created: optionalString(body.created),
    });
  }

  /** The bot's own identity, for filtering its own messages out of ingestion. */
  async getMe(): Promise<Result<WebexPerson, 'WEBEX_API_ERROR'>> {
    const result = await this.get('/people/me');
    if (!result.ok) return result;
    const body = result.val;

    const id = optionalString(body.id);
    if (!id) return err('WEBEX_API_ERROR' as const, { message: 'people/me response missing id' });

    const emails = Array.isArray(body.emails)
      ? body.emails.filter((value): value is string => typeof value === 'string')
      : [];

    return ok({ id, emails, displayName: optionalString(body.displayName) });
  }
}
