/**
 * The refId scheme for drive documents — SharePoint libraries and personal
 * OneDrive alike.
 *
 * `${driveId}/${itemId}`, and deliberately NOT the `${upn}/${kind}/${id}`
 * shape mail, calendar and tasks use. Those are indexed into their owner's
 * view alone, so ownership IS their ACL and the owner belongs in the ref. A
 * document is shared: the person who indexed it is not the set of people who
 * may read it, so an owner segment would encode an answer that is wrong for
 * everyone but one user. What identifies a document is where it lives, and
 * the live gate decides who may see it (see drive-verifier.ts).
 *
 * Personal OneDrive uses this same scheme even though owner-equality would
 * happen to work there. Two schemes would make the gate's correctness depend
 * on which pipeline wrote the row — a property nobody can hold in their head
 * six months later — and `AccessVerifier.verifyAccess` receives only
 * `{provider, refId}`, never metadata, so there is no fast path to take
 * anyway.
 *
 * Chunked documents get a `#0001` suffix appended by chunkRefId. Both parsers
 * below strip it, so a chunk ref resolves to the same document as its parent.
 */

/**
 * The knowledge `provider` for drive documents.
 *
 * A separate key from 'microsoft' on purpose: the provider column is what
 * selects the ACL verifier, and these rows need the live one rather than
 * mail's owner-equality check. It also keeps the Microsoft disconnect purge
 * (which deletes `${upn}/`-prefixed chunks under provider 'microsoft')
 * correctly clear of documents a departing user merely indexed.
 */
export const SHAREPOINT_KNOWLEDGE_PROVIDER = 'sharepoint';

export function sharepointRefId(driveId: string, itemId: string): string {
  return `${driveId}/${itemId}`;
}

/** Strip the `#0001` chunk suffix chunkRefId appends, leaving the document ref. */
function baseRefOf(refId: string): string {
  const hash = refId.indexOf('#');
  return hash > 0 ? refId.slice(0, hash) : refId;
}

/**
 * The drive and item a refId names, or null when it is malformed — which must
 * deny downstream, per the gate's default-deny contract.
 *
 * Splits on the FIRST separator: Graph drive ids are URL-safe base64 with no
 * '/', while item ids are opaque, so giving the remainder to the item id is
 * the tolerant reading of the two.
 */
export function partsOfSharepointRefId(refId: string): { driveId: string; itemId: string } | null {
  const base = baseRefOf(refId);
  const slash = base.indexOf('/');
  if (slash <= 0) return null;
  const driveId = base.slice(0, slash);
  const itemId = base.slice(slash + 1);
  return driveId && itemId ? { driveId, itemId } : null;
}
