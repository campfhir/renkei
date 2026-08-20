/**
 * The Zoom connector's verifyAccess implementation (connector data contract
 * item #5; RENKEI.md Decision #18).
 *
 * v1 ACL: the meeting HOST owns the transcript. Host-of-meeting is an
 * immutable fact — it is fixed when the meeting happens and can never drift
 * the way room membership can — so the ref bakes it in as
 * `${hostEmail}/${meetingUuid}` and verification is a pure string check, no
 * network. Participant-based ACL (letting attendees see transcripts of
 * meetings they were in, via Zoom's past-participants API) is declared
 * future work; it widens access, so shipping host-only first errs on the
 * side of disclosure, not leakage.
 *
 * Ref anatomy: the email cannot contain '/', so the FIRST '/' always ends
 * the host segment. Everything after it is the meeting uuid — which MAY
 * itself contain '/', '=', '+' — optionally followed by a chunk suffix like
 * `#0001` or `#summary` appended by the indexer. None of that disturbs host
 * extraction.
 */

import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export function zoomRefId(hostEmail: string, meetingUuid: string): string {
  return `${hostEmail.toLowerCase()}/${meetingUuid}`;
}

export function hostOfZoomRefId(refId: string): string | null {
  const slash = refId.indexOf('/');
  return slash > 0 ? refId.slice(0, slash).toLowerCase() : null;
}

export function createZoomAccessVerifier(): AccessVerifier {
  return {
    provider: 'zoom',
    ownerScoped: true,
    async verifyAccess(
      userId: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      const user = userId.trim().toLowerCase();
      const allowed =
        user.length === 0 ? [] : refs.filter((ref) => hostOfZoomRefId(ref.refId) === user);
      return ok(allowed.map((ref) => ({ ...ref })));
    },
  };
}
