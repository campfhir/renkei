/**
 * Minimal WebEx API client. Built for the bot token, but the bearer is
 * just a constructor argument — `listRooms`/`sendNoteToSelf` and friends
 * work identically against a user's own OAuth token, which is how a
 * caller with no MCP session of its own (the interactive worker) can
 * still act as a specific person. Live queries only — this connector
 * persists nothing itself (see the data contract in index.ts).
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { LaneLimiter, type RequestLane } from '@renkei/rate-limit';

const API_BASE = 'https://webexapis.com/v1';
/**
 * Bounds every call out to WebEx. Without this, an unreachable host (DNS not
 * yet up right after a boot, a stalled connection) hangs `fetch` forever —
 * and a hung request in the worker's webhook-health sweep or in ambient
 * message processing has nothing to say why it never came back.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/** The space `sendNoteToSelf` finds or creates — see its own doc comment. */
const NOTE_TO_SELF_TITLE = 'Note to Self';
/** At most this many group rooms probed for membership before giving up and creating one. */
const SOLO_PROBE_CAP = 8;

/**
 * Process-scoped, split by lane: every WebexClient in this process shares
 * these two buckets.
 *
 * Background covers webhook floods and sweeps over many tenants, which would
 * otherwise fire a burst at WebEx all at once. Interactive covers the live
 * ACL check behind a knowledge search, which is sized for one whole query
 * without queuing: a search verifies up to one membership call per distinct
 * room across its overfetched candidates — as many as 20 — and the gate drops
 * whatever is still unverified after 3 seconds. Sharing one bucket meant a
 * webhook flood could push a user's search past that deadline, and withheld
 * results read as "you do not have access".
 */
const limiter = new LaneLimiter({
  interactive: { capacity: 20, refillPerSecond: 10 },
  background: { capacity: 5, refillPerSecond: 5 },
});

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
  /** Post into a space. One of roomId / toPersonEmail is required. */
  roomId?: string;
  /** Direct-message a person instead of posting into a space. */
  toPersonEmail?: string;
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
  /**
   * The lane every call from this client uses. Set it at construction, where
   * the caller knows what it is doing: the knowledge verifier builds an
   * interactive client, the worker a background one.
   */
  private readonly lane: RequestLane;

  constructor(
    private readonly botToken: string,
    options?: { lane?: RequestLane }
  ) {
    this.lane = options?.lane ?? 'background';
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<Result<Record<string, unknown>, 'WEBEX_API_ERROR'>> {
    await limiter.take(this.lane);
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('WEBEX_API_ERROR' as const, {
        message: timedOut
          ? `WebEx API timed out after ${REQUEST_TIMEOUT_MS}ms for ${path}`
          : 'WebEx API unreachable',
      });
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

  /** One room's details — its title, for a day window's heading. */
  async getRoom(roomId: string): Promise<Result<WebexRoom, 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/rooms/${encodeURIComponent(roomId)}`);
    if (!result.ok) return result;
    const room = readRoom(result.val);
    if (!room) return err('WEBEX_API_ERROR' as const, { message: 'room response missing id' });
    return ok(room);
  }

  /**
   * A page of a room's history, newest first, ending before a point in
   * time or before a given message — the two cursors WebEx offers. The
   * room-day rebuild walks a day backwards with these until it crosses
   * the day's start.
   */
  async listMessagesBefore(
    roomId: string,
    options: { before?: string; beforeMessage?: string; max?: number } = {}
  ): Promise<Result<WebexMessage[], 'WEBEX_API_ERROR'>> {
    const params = new URLSearchParams({ roomId, max: String(options.max ?? 100) });
    if (options.beforeMessage) params.set('beforeMessage', options.beforeMessage);
    else if (options.before) params.set('before', options.before);
    const result = await this.get(`/messages?${params.toString()}`);
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

  /**
   * Group rooms the token's owner belongs to — never 1:1s, which always
   * have exactly two members and so can never be the solo room
   * `sendNoteToSelf` is hunting for.
   */
  private async listGroupRooms(max = 100): Promise<Result<WebexRoom[], 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/rooms?max=${max}&type=group&sortBy=lastactivity`);
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

  /** How many people are currently in a room. */
  private async roomMemberCount(roomId: string): Promise<Result<number, 'WEBEX_API_ERROR'>> {
    const result = await this.get(`/memberships?roomId=${encodeURIComponent(roomId)}&max=2`);
    if (!result.ok) return result;
    const items = result.val.items;
    if (!Array.isArray(items)) {
      return err('WEBEX_API_ERROR' as const, { message: 'memberships response missing items' });
    }
    return ok(items.length);
  }

  private async createRoom(title: string): Promise<Result<{ id: string }, 'WEBEX_API_ERROR'>> {
    const result = await this.request('POST', '/rooms', { title });
    if (!result.ok) return result;
    const id = optionalString(result.val.id);
    if (!id) return err('WEBEX_API_ERROR' as const, { message: 'room response missing id' });
    return ok({ id });
  }

  /**
   * Post to the token owner's own private note-to-self space. WebEx cannot
   * deliver a 1:1 message to your own address, so this is THE way to WebEx
   * yourself: find a group room containing only you (title matches probed
   * first, so the space this creates is found on the first probe of every
   * later call), creating one titled "Note to Self" if none exists yet,
   * then post there.
   *
   * A from-scratch twin of the `webex_note_to_self` MCP tool
   * (apps/web/lib/mcp-tools/webex/index.ts), for callers with no MCP
   * session of their own to call that tool through — today, the
   * interactive worker's run-failure notifier.
   */
  async sendNoteToSelf(
    markdown: string
  ): Promise<Result<{ id: string; roomId: string }, 'WEBEX_API_ERROR'>> {
    const roomsResult = await this.listGroupRooms(100);
    if (!roomsResult.ok) return roomsResult;
    const titled = (room: WebexRoom) =>
      (room.title ?? '').trim().toLowerCase() === NOTE_TO_SELF_TITLE.toLowerCase();
    const candidates = [
      ...roomsResult.val.filter(titled),
      ...roomsResult.val.filter((room) => !titled(room)),
    ];

    let roomId = '';
    for (const room of candidates.slice(0, SOLO_PROBE_CAP)) {
      const countResult = await this.roomMemberCount(room.id);
      if (!countResult.ok) return countResult;
      if (countResult.val === 1) {
        roomId = room.id;
        break;
      }
    }

    if (!roomId) {
      const created = await this.createRoom(NOTE_TO_SELF_TITLE);
      if (!created.ok) return created;
      roomId = created.val.id;
    }

    const sent = await this.postMessage({ roomId, markdown });
    if (!sent.ok) return sent;
    return ok({ id: sent.val.id, roomId });
  }
}
