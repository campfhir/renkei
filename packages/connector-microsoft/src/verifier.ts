/**
 * The Microsoft connector's verifyAccess implementation (connector data
 * contract item #5; RENKEI.md Decision #18).
 *
 * Mail, calendar events, and To Do tasks are indexed only into the OWNER's
 * view — each item was fetched with its owner's delegated grant and its refId
 * names that owner. Ownership therefore IS the whole ACL: a ref is granted
 * exactly when the requesting user is the owner encoded in it. No network
 * call could add information here; the "live" element of the check is the
 * verified identity-spine email the gate passes in as userId, which is
 * established at session time, not stored alongside the index.
 *
 * Everything unresolvable — a malformed ref, a foreign owner — denies, per
 * the gate's default-deny contract.
 */

import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { ownerOfMicrosoftRefId } from './refs';

export function createMicrosoftAccessVerifier(): AccessVerifier {
  return {
    provider: 'microsoft',
    async verifyAccess(
      userId: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      const requester = userId.trim().toLowerCase();
      const allowed = refs.filter((ref) => {
        const owner = ownerOfMicrosoftRefId(ref.refId);
        return owner !== null && owner === requester;
      });
      return ok(allowed.map((ref) => ({ ...ref })));
    },
  };
}
