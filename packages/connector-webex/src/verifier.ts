/**
 * The WebEx connector's verifyAccess implementation (connector data
 * contract item #5; RENKEI.md Decision #18).
 *
 * A WebEx message's access rule IS its room's membership, so the ref
 * encodes the room — `${roomId}/${messageId}` — and verification asks
 * WebEx, live, whether the requesting user is currently a member. One
 * membership call covers every ref in the same room: that is deduplication
 * of identical object-level checks, not a weakening of them, since every
 * message in a room shares exactly this rule.
 *
 * Everything unresolvable — a malformed ref, an API failure — denies, per
 * the gate's default-deny contract.
 */

import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { WebexClient } from './client';

export function webexRefId(roomId: string, messageId: string): string {
  return `${roomId}/${messageId}`;
}

function roomOf(refId: string): string | null {
  const slash = refId.indexOf('/');
  return slash > 0 ? refId.slice(0, slash) : null;
}

export function createWebexAccessVerifier(
  client: Pick<WebexClient, 'isRoomMember'>
): AccessVerifier {
  return {
    provider: 'webex',
    async verifyAccess(
      userEmail: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      const rooms = new Set<string>();
      for (const ref of refs) {
        const room = roomOf(ref.refId);
        if (room) rooms.add(room);
      }

      const allowedRooms = new Set<string>();
      await Promise.all(
        [...rooms].map(async (roomId) => {
          try {
            const member = await client.isRoomMember(roomId, userEmail);
            if (member.ok && member.val) allowedRooms.add(roomId);
          } catch {
            // Unverifiable room → its messages stay denied.
          }
        })
      );

      const allowed = refs.filter((ref) => {
        const room = roomOf(ref.refId);
        return room !== null && allowedRooms.has(room);
      });
      return ok(allowed.map((ref) => ({ ...ref })));
    },
  };
}
