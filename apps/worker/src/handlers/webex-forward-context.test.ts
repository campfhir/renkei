/**
 * findForwardedOrigin's contract: scan the token owner's own rooms (never
 * the excluded one), match on normalized text equality, stop at the first
 * hit, and fail closed — no match, short text, and API errors all resolve
 * to null rather than throwing, since this is enrichment, not the capture.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexMessage, WebexRoom } from '@renkei/connector-webex';
import { findForwardedOrigin, type WebexSearchClient } from './webex-forward-context';

function room(over: Partial<WebexRoom>): WebexRoom {
  return { id: 'room-x', title: 'Room X', type: 'group', lastActivity: null, ...over };
}

function msg(over: Partial<WebexMessage>): WebexMessage {
  return {
    id: 'm-1',
    roomId: 'room-x',
    roomType: 'group',
    text: 'hello',
    personId: 'p-1',
    personEmail: 'someone@example.com',
    parentId: null,
    created: '2026-08-07T11:00:00Z',
    ...over,
  };
}

function stubClient(
  rooms: WebexRoom[],
  messagesByRoom: Record<string, WebexMessage[]>
): {
  client: WebexSearchClient;
  listedRooms: string[];
} {
  const listedRooms: string[] = [];
  return {
    listedRooms,
    client: {
      listRooms: async () => ok(rooms),
      listMessages: async (roomId: string) => {
        listedRooms.push(roomId);
        return ok(messagesByRoom[roomId] ?? []);
      },
    },
  };
}

const LONG_TEXT = 'The build server has been down since this morning, someone please check.';

describe('findForwardedOrigin', () => {
  it('finds the matching message in another room, ignoring whitespace differences', async () => {
    const { client } = stubClient(
      [room({ id: 'room-elsewhere', title: 'Ops' }), room({ id: 'room-here', title: 'Here' })],
      {
        'room-elsewhere': [
          msg({ id: 'orig-1', roomId: 'room-elsewhere', text: `  ${LONG_TEXT}\n` }),
        ],
      }
    );

    const result = await findForwardedOrigin({
      client,
      text: LONG_TEXT,
      excludeRoomId: 'room-here',
    });

    expect(result).toEqual({
      roomId: 'room-elsewhere',
      roomTitle: 'Ops',
      messageId: 'orig-1',
      personEmail: 'someone@example.com',
      created: '2026-08-07T11:00:00Z',
    });
  });

  it('never scans the excluded room', async () => {
    const { client, listedRooms } = stubClient([room({ id: 'room-here' })], {
      'room-here': [msg({ id: 'same-room', roomId: 'room-here', text: LONG_TEXT })],
    });

    const result = await findForwardedOrigin({
      client,
      text: LONG_TEXT,
      excludeRoomId: 'room-here',
    });

    expect(result).toBeNull();
    expect(listedRooms).toEqual([]);
  });

  it('returns null for short text — too ambiguous to match reliably', async () => {
    const { client, listedRooms } = stubClient([room({ id: 'room-elsewhere' })], {});

    const result = await findForwardedOrigin({
      client,
      text: 'ok thanks',
      excludeRoomId: 'room-here',
    });

    expect(result).toBeNull();
    expect(listedRooms).toEqual([]);
  });

  it('returns null, not a throw, when listing rooms fails', async () => {
    const client: WebexSearchClient = {
      listRooms: async () => err('WEBEX_API_ERROR' as const),
      listMessages: async () => ok([]),
    };

    const result = await findForwardedOrigin({
      client,
      text: LONG_TEXT,
      excludeRoomId: 'room-here',
    });

    expect(result).toBeNull();
  });

  it('skips a room whose message listing fails and keeps scanning the rest', async () => {
    const rooms = [room({ id: 'room-broken' }), room({ id: 'room-good', title: 'Good' })];
    let calls = 0;
    const client: WebexSearchClient = {
      listRooms: async () => ok(rooms),
      listMessages: async (roomId: string) => {
        calls += 1;
        if (roomId === 'room-broken') return err('WEBEX_API_ERROR' as const);
        return ok([msg({ id: 'orig-2', roomId: 'room-good', text: LONG_TEXT })]);
      },
    };

    const result = await findForwardedOrigin({
      client,
      text: LONG_TEXT,
      excludeRoomId: 'room-here',
    });

    expect(calls).toBe(2);
    expect(result?.messageId).toBe('orig-2');
  });
});
