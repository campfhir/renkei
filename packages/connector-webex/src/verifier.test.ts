/**
 * The verifier's contract: membership in the ref's room grants the ref,
 * everything unresolvable denies, and identical room checks are made once.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { createWebexAccessVerifier, webexRefId } from './verifier';

function ref(roomId: string, messageId: string) {
  return { provider: 'webex', refId: webexRefId(roomId, messageId) };
}

describe('createWebexAccessVerifier', () => {
  it('allows refs whose room the user belongs to, denies the rest', async () => {
    const verifier = createWebexAccessVerifier({
      isRoomMember: async (roomId) => ok(roomId === 'room-a'),
    });

    const result = await verifier.verifyAccess('sam@example.com', [
      ref('room-a', 'm1'),
      ref('room-a', 'm2'),
      ref('room-b', 'm3'),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.map((r) => r.refId)).toEqual(['room-a/m1', 'room-a/m2']);
    }
  });

  it('checks each distinct room once', async () => {
    const checked: string[] = [];
    const verifier = createWebexAccessVerifier({
      isRoomMember: async (roomId) => {
        checked.push(roomId);
        return ok(true);
      },
    });

    await verifier.verifyAccess('sam@example.com', [
      ref('room-a', 'm1'),
      ref('room-a', 'm2'),
      ref('room-b', 'm3'),
    ]);

    expect(checked.sort()).toEqual(['room-a', 'room-b']);
  });

  it('denies refs whose membership check fails', async () => {
    const verifier = createWebexAccessVerifier({
      isRoomMember: async () => err('WEBEX_API_ERROR' as const),
    });

    const result = await verifier.verifyAccess('sam@example.com', [ref('room-a', 'm1')]);
    if (result.ok) expect(result.val).toEqual([]);
  });

  it('denies malformed refs that name no room', async () => {
    const verifier = createWebexAccessVerifier({ isRoomMember: async () => ok(true) });

    const result = await verifier.verifyAccess('sam@example.com', [
      { provider: 'webex', refId: 'no-room-part' },
    ]);
    if (result.ok) expect(result.val).toEqual([]);
  });
});
