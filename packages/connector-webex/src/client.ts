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
  /** Thread root when the message is a threaded reply. */
  parentId: string | null;
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

export interface WebexAttachmentAction {
  id: string;
  personId: string | null;
  roomId: string | null;
  /** The message carrying the card whose button was pressed. */
  messageId: string | null;
  /** The submitted Action.Submit data plus any card Input values. */
  inputs: Record<string, unknown>;
}

export interface OutgoingMessage {
  roomId: string;
  /** Thread root to reply under; omitted = new top-level message. */
  parentId?: string;
  markdown?: string;
  text?: string;
  /** Adaptive Card attachments, pre-shaped by the caller (see cards.ts). */
  attachments?: unknown[];
}

export class WebexClient {
  constructor(private readonly botToken: string) {}

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<Result<Record<string, unknown>, 'WEBEX_API_ERROR'>> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return err('WEBEX_API_ERROR' as const, { message: 'WebEx API unreachable' });
    }

    if (!response.ok) {
      return err('WEBEX_API_ERROR' as const, {
        message: `WebEx API ${response.status} for ${path}`,
      });
    }

    const parsed: unknown = await response.json().catch(() => null);
    if (!isRecord(parsed)) {
      return err('WEBEX_API_ERROR' as const, { message: `WebEx API returned no JSON for ${path}` });
    }
    return ok(parsed);
  }

  private get(path: string): Promise<Result<Record<string, unknown>, 'WEBEX_API_ERROR'>> {
    return this.request('GET', path);
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
      parentId: optionalString(body.parentId),
      created: optionalString(body.created),
    });
  }

  /**
   * Is this person currently a member of the room? The live ACL check for
   * WebEx content: room membership is exactly WebEx's own access rule for
   * messages, verified at query time with the bot credential.
   */
  async isRoomMember(roomId: string, personEmail: string): Promise<Result<boolean, 'WEBEX_API_ERROR'>> {
    const query = `roomId=${encodeURIComponent(roomId)}&personEmail=${encodeURIComponent(personEmail)}`;
    const result = await this.get(`/memberships?${query}`);
    if (!result.ok) return result;
    const items = result.val.items;
    return ok(Array.isArray(items) && items.length > 0);
  }

  /** Post a message (optionally with card attachments) as the bot. */
  async postMessage(message: OutgoingMessage): Promise<Result<{ id: string }, 'WEBEX_API_ERROR'>> {
    const result = await this.request('POST', '/messages', message);
    if (!result.ok) return result;
    const id = optionalString(result.val.id);
    if (!id) return err('WEBEX_API_ERROR' as const, { message: 'message response missing id' });
    return ok({ id });
  }

  /**
   * Fetch an Action.Submit event's substance from the API. The webhook only
   * carries the action id — and even if it carried more, acting on unfetched
   * webhook data would mean trusting the network instead of WebEx.
   */
  async getAttachmentAction(
    actionId: string
  ): Promise<Result<WebexAttachmentAction, 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/attachment/actions/${encodeURIComponent(actionId)}`);
    if (!result.ok) return result;
    const body = result.val;

    const id = optionalString(body.id);
    if (!id) {
      return err('WEBEX_API_ERROR' as const, { message: 'attachment action missing id' });
    }
    const inputs = body.inputs;

    return ok({
      id,
      personId: optionalString(body.personId),
      roomId: optionalString(body.roomId),
      messageId: optionalString(body.messageId),
      inputs:
        typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs)
          ? { ...inputs }
          : {},
    });
  }

  /** Look up a person — how a button press resolves to an identity. */
  async getPerson(personId: string): Promise<Result<WebexPerson, 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/people/${encodeURIComponent(personId)}`);
    if (!result.ok) return result;
    const body = result.val;

    const id = optionalString(body.id);
    if (!id) return err('WEBEX_API_ERROR' as const, { message: 'person response missing id' });

    const emails = Array.isArray(body.emails)
      ? body.emails.filter((value): value is string => typeof value === 'string')
      : [];

    return ok({ id, emails, displayName: optionalString(body.displayName) });
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
