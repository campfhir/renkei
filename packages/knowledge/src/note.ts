/**
 * Authored knowledge — notes written INTO Renkei by a person or their
 * agent over MCP, as opposed to everything else in knowledge_chunks,
 * which is ingested FROM a provider by the pipeline.
 *
 * Provider 'note' is the discriminator. The gate default-denies providers
 * with no registered verifier, so authored rows are invisible to search
 * until this verifier is wired in — and the verifier is a pure ownership
 * check: the ref bakes the author's email in as `${ownerEmail}/${noteId}`
 * (the zoom pattern — email cannot contain '/', so the first '/' always
 * ends the owner segment) and only the author reads their notes. An
 * agent's notes belong to its OWNER: agents act under the owner's
 * identity, so what they write is readable exactly where the owner reads.
 *
 * Immutability of ingested knowledge falls out of construction, not
 * checking: the note tools never take a provider argument and only ever
 * address `note` refs under the caller's own email prefix, so jira/
 * confluence/microsoft/webex/zoom rows are simply unreachable from them.
 * AUTHORED_PROVIDERS names the writable set for the day a second authored
 * provider exists.
 */

import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export const NOTE_KNOWLEDGE_PROVIDER = 'note';

/** The providers whose rows MCP write tools may touch. */
export const AUTHORED_PROVIDERS: readonly string[] = [NOTE_KNOWLEDGE_PROVIDER];

/**
 * Notes chunk WITHOUT overlap, unlike pipeline content: an edit surface
 * must reconstruct the exact original by concatenating chunks in order,
 * and overlap would weld duplicated seams into every re-save. Retrieval
 * loses a little cross-chunk context; notes are short and titled, so the
 * trade goes the other way from mail and documents.
 */
export const NOTE_CHUNKING = { maxChars: 2_000, overlap: 0 } as const;

export function noteRefId(ownerEmail: string, noteId: string): string {
  return `${ownerEmail.toLowerCase()}/${noteId}`;
}

/** The owner segment of a note ref — chunk suffixes (`#0001`) don't disturb it. */
export function ownerOfNoteRefId(refId: string): string | null {
  const slash = refId.indexOf('/');
  return slash > 0 ? refId.slice(0, slash).toLowerCase() : null;
}

export function createNoteAccessVerifier(): AccessVerifier {
  return {
    provider: NOTE_KNOWLEDGE_PROVIDER,
    async verifyAccess(
      userId: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      const user = userId.trim().toLowerCase();
      const allowed =
        user.length === 0 ? [] : refs.filter((ref) => ownerOfNoteRefId(ref.refId) === user);
      return ok(allowed.map((ref) => ({ ...ref })));
    },
  };
}
