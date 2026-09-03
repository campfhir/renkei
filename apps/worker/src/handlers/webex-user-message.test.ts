/**
 * The all-spaces ingest's one hard guard.
 *
 * What must hold: a message the WATCHER typed reaches the pipeline, and a
 * message RENKEI sent as them does not. Those used to be the same case —
 * the guard skipped by authorship — and collapsing them threw away every
 * message the person actually wrote.
 *
 * The negative direction is the one worth pinning. A guard that lets Renkei's
 * own posts through looks identical to a working pipeline right up until an
 * agent replies to itself in a loop.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { createWebexUserMessageHandler } from './webex-user-message';
import type { ClaimedEvent } from '../queue';
import type { WebexMessage } from '@renkei/connector-webex';

const WATCHER_ACCOUNT = 'watcher-account-id';
const TENANT = 'tenant-1';

function event(messageId: string): ClaimedEvent {
  // Only the fields the handler reads; the queue row carries more.
  const claimed: unknown = {
    id: 'queue-row-1',
    tenant_id: TENANT,
    source: 'webex',
    type: 'user-message.created',
    payload: { id: messageId, accountId: WATCHER_ACCOUNT },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return claimed as ClaimedEvent;
}

function handlerWith(options: {
  personId: string;
  sentByRenkei?: boolean;
  text?: string | null;
  roomType?: string | null;
  parentId?: string | null;
  published: unknown[];
  nearbyMessages?: WebexMessage[];
  listMessagesFails?: boolean;
}) {
  return createWebexUserMessageHandler({
    resolveAccess: async () => ({
      accessToken: 'token',
      subject: 'watcher@example.com',
      accountId: WATCHER_ACCOUNT,
    }),
    makeClient: () => ({
      getMessage: async (id: string) =>
        ok({
          id,
          roomId: 'room-1',
          roomType: options.roomType === undefined ? 'group' : options.roomType,
          parentId: options.parentId === undefined ? null : options.parentId,
          personId: options.personId,
          personEmail: 'someone@example.com',
          text: options.text === undefined ? 'hello there' : options.text,
          created: '2026-08-25T10:00:00.000Z',
        }),
      listMessages: async () =>
        options.listMessagesFails
          ? err('WEBEX_API_ERROR' as const, { message: 'boom' })
          : ok(options.nearbyMessages ?? []),
    }),
    wasSentByRenkei: async () => options.sentByRenkei ?? false,
    publish: async (payload: unknown) => {
      options.published.push(payload);
    },
  });
}

describe('webex all-spaces ingest', () => {
  it('publishes a message the watcher typed themselves', async () => {
    // The regression this exists for: watcher-authored used to mean skipped,
    // so an agent could never trigger on something its owner posted.
    const published: unknown[] = [];
    const handler = handlerWith({ personId: WATCHER_ACCOUNT, published });

    const result = await handler(event('msg-typed-by-watcher'));

    expect(result).toBeUndefined();
    expect(published).toHaveLength(1);
  });

  it('publishes a message someone else posted', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', published });

    await handler(event('msg-from-colleague'));

    expect(published).toHaveLength(1);
  });

  it('skips a message Renkei sent as the watcher', async () => {
    // The loop guard. Without it an agent that replies in a space answers
    // its own reply until the daily run cap intervenes.
    const published: unknown[] = [];
    const handler = handlerWith({
      personId: WATCHER_ACCOUNT,
      sentByRenkei: true,
      published,
    });

    const result = await handler(event('msg-renkei-sent'));

    expect(result).toBe('skipped');
    expect(published).toHaveLength(0);
  });

  it('skips a message with no text', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', text: null, published });

    expect(await handler(event('msg-empty'))).toBe('skipped');
    expect(published).toHaveLength(0);
  });

  it('names the watcher as the owner, whoever sent it', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', published });

    await handler(event('msg-1'));

    expect(published[0]).toMatchObject({
      tenantId: TENANT,
      provider: 'webex',
      type: 'message.received',
      ownerSubject: 'watcher@example.com',
    });
  });

  it('carries the room type, so a direct-message filter has something to read', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', roomType: 'direct', published });

    await handler(event('msg-dm'));

    expect(published[0]).toMatchObject({ data: { roomType: 'direct' } });
  });

  it('carries the thread root, so an agent can answer in the same thread', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', parentId: 'msg-root', published });

    await handler(event('msg-threaded-reply'));

    expect(published[0]).toMatchObject({ data: { parentId: 'msg-root' } });
  });

  it('publishes an empty thread root for a top-level message', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', published });

    await handler(event('msg-top-level'));

    expect(published[0]).toMatchObject({ data: { parentId: '' } });
  });

  it('publishes an empty room type when the API omits it, never dropping the message', async () => {
    // The filter side fails closed on ''; the ingest side must not add a
    // second, silent drop of its own.
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', roomType: null, published });

    await handler(event('msg-untyped-room'));

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ data: { roomType: '' } });
  });

  it('carries pre-fetched room history, so a step can skip webex_list_messages', async () => {
    const published: unknown[] = [];
    const nearbyMessages: WebexMessage[] = [
      {
        id: 'msg-earlier',
        roomId: 'room-1',
        roomType: 'group',
        personId: 'person-2',
        personEmail: 'alice@example.com',
        parentId: null,
        text: 'anyone seen the deploy fail?',
        created: '2026-08-25T09:58:00.000Z',
      },
      {
        id: 'msg-reply',
        roomId: 'room-1',
        roomType: 'group',
        personId: 'person-3',
        personEmail: 'bob@example.com',
        parentId: 'msg-earlier',
        text: 'yeah, looking now',
        created: '2026-08-25T09:59:00.000Z',
      },
    ];
    const handler = handlerWith({ personId: 'somebody-else', nearbyMessages, published });

    await handler(event('msg-1'));

    // The reply's thread marker rides along too — the same "in thread"
    // shape webex_list_messages itself renders.
    for (const expected of [
      'alice@example.com',
      'anyone seen the deploy fail?',
      'bob@example.com',
      'in thread msg-earlier',
    ]) {
      expect(published[0]).toMatchObject({
        data: { nearbyMessages: expect.stringContaining(expected) },
      });
    }
  });

  it('degrades to empty history rather than dropping the message when the pre-fetch fails', async () => {
    const published: unknown[] = [];
    const handler = handlerWith({ personId: 'somebody-else', listMessagesFails: true, published });

    await handler(event('msg-1'));

    // The triggering message still gets published — a context-fetch miss
    // costs a step its shortcut, not the whole message its ingestion. The
    // step's own webex_list_messages tool call remains a fallback.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ data: { nearbyMessages: '' } });
  });
});
