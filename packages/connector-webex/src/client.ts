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

export interface WebexRoom {
  id: string;
  title: string | null;
  type: string | null;
  lastActivity: string | null;
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

/** A webhook registration as WebEx reports it. */
export interface WebexWebhook {
  id: string;
  name: string | null;
  targetUrl: string | null;
  resource: string | null;
  event: string | null;
  /** WebEx echoes the signing secret back on reads — how drift is detected. */
  secret: string | null;
  /** 'active', or 'inactive' once WebEx gives up on a failing target. */
  status: string | null;
}

export interface WebhookRegistration {
  name: string;
  targetUrl: string;
  resource: string;
  event: string;
  secret: string;
}

function readMessage(body: Record<string, unknown>): WebexMessage | null {
  const id = optionalString(body.id);
  const roomId = optionalString(body.roomId);
  if (!id || !roomId) return null;

  return {
    id,
    roomId,
    roomType: optionalString(body.roomType),
    text: optionalString(body.text),
    personId: optionalString(body.personId),
    personEmail: optionalString(body.personEmail),
    parentId: optionalString(body.parentId),
    created: optionalString(body.created),
  };
}

function readRoom(body: Record<string, unknown>): WebexRoom | null {
  const id = optionalString(body.id);
  if (!id) return null;
  return {
    id,
    title: optionalString(body.title),
    type: optionalString(body.type),
    lastActivity: optionalString(body.lastActivity),
  };
}

function readWebhook(body: Record<string, unknown>): WebexWebhook | null {
  const id = optionalString(body.id);
  if (!id) return null;
  return {
    id,
    name: optionalString(body.name),
    targetUrl: optionalString(body.targetUrl),
    resource: optionalString(body.resource),
    event: optionalString(body.event),
    secret: optionalString(body.secret),
    status: optionalString(body.status),
  };
}

export class WebexClient {
  constructor(private readonly botToken: string) {}

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
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

    // Deletes answer 204 with no body.
    if (response.status === 204) return ok({});

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
    const message = readMessage(result.val);
    if (!message) {
      return err('WEBEX_API_ERROR' as const, { message: 'message response missing id/roomId' });
    }
    return ok(message);
  }

  /**
   * Rooms the token's owner belongs to, most recently active first. Works
   * with any bearer — a bot token sees the bot's rooms, a user token sees
   * the user's own — which is what lets a user's own grant search spaces the
   * bot was never invited to (see webex-forward-context.ts in the worker).
   */
  async listRooms(max = 30): Promise<Result<WebexRoom[], 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/rooms?max=${max}&sortBy=lastactivity`);
    if (!result.ok) return result;
    const items = result.val.items;
    if (!Array.isArray(items)) {
      return err('WEBEX_API_ERROR' as const, { message: 'rooms response missing items' });
    }
    const rooms: WebexRoom[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const room = readRoom(item);
      if (room) rooms.push(room);
    }
    return ok(rooms);
  }

  /** Recent messages in a room, newest first — the token owner's own access. */
  async listMessages(roomId: string, max = 20): Promise<Result<WebexMessage[], 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/messages?roomId=${encodeURIComponent(roomId)}&max=${max}`);
    if (!result.ok) return result;
    const items = result.val.items;
    if (!Array.isArray(items)) {
      return err('WEBEX_API_ERROR' as const, { message: 'messages response missing items' });
    }
    const messages: WebexMessage[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const message = readMessage(item);
      if (message) messages.push(message);
    }
    return ok(messages);
  }

  /**
   * Is this person currently a member of the room? The live ACL check for
   * WebEx content: room membership is exactly WebEx's own access rule for
   * messages, verified at query time with the bot credential.
   */
  async isRoomMember(
    roomId: string,
    personEmail: string
  ): Promise<Result<boolean, 'WEBEX_API_ERROR'>> {
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

  /**
   * The bot's webhook registrations. Webhooks are scoped to the creating
   * credential, so this is exactly the set Renkei's bot owns — the cap of
   * 100 is far beyond the two registrations Renkei maintains.
   */
  async listWebhooks(): Promise<Result<WebexWebhook[], 'WEBEX_API_ERROR'>> {
    const result = await this.get('/webhooks?max=100');
    if (!result.ok) return result;
    const items = result.val.items;
    if (!Array.isArray(items)) {
      return err('WEBEX_API_ERROR' as const, { message: 'webhooks response missing items' });
    }
    const hooks: WebexWebhook[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const hook = readWebhook(item);
      if (hook) hooks.push(hook);
    }
    return ok(hooks);
  }

  /** Register a webhook — Renkei pointing WebEx at its own receipt endpoint. */
  async createWebhook(
    registration: WebhookRegistration
  ): Promise<Result<WebexWebhook, 'WEBEX_API_ERROR'>> {
    const result = await this.request('POST', '/webhooks', registration);
    if (!result.ok) return result;
    const hook = readWebhook(result.val);
    if (!hook) return err('WEBEX_API_ERROR' as const, { message: 'webhook response missing id' });
    return ok(hook);
  }

  /** Remove a webhook — half of "recreate", and how strays are cleaned up. */
  async deleteWebhook(webhookId: string): Promise<Result<void, 'WEBEX_API_ERROR'>> {
    const result = await this.request('DELETE', `/webhooks/${encodeURIComponent(webhookId)}`);
    if (!result.ok) return result;
    return ok();
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
