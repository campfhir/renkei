/**
 * The Microsoft connector's refId scheme — the string the retrieval gate's
 * ACL decision hangs on, so its shape is a contract, not a convenience.
 *
 * `${upn}/${kind}/${id}`: the owner's UPN comes FIRST so ownership can be
 * read back without knowing anything about the kind or the (opaque, Graph-
 * assigned, occasionally '/'-free-but-never-guaranteed) object id. The UPN is
 * lowercased at construction so comparison is byte-equality; Graph treats
 * UPNs case-insensitively but reports them in mixed case.
 *
 * Long documents are indexed as chunks with a `#0001`-style suffix appended
 * after the id. Because the owner is the FIRST segment, a suffixed refId
 * parses identically — ownerOfMicrosoftRefId never needs to know about
 * chunking.
 */

export type MicrosoftRefKind = 'msg' | 'evt' | 'task';

export function microsoftRefId(upn: string, kind: MicrosoftRefKind, id: string): string {
  return `${upn.toLowerCase()}/${kind}/${id}`;
}

/**
 * The owning UPN of a refId, lowercased — or null when the ref is malformed
 * (no separator, or an empty owner segment). Null must deny downstream.
 */
export function ownerOfMicrosoftRefId(refId: string): string | null {
  const slash = refId.indexOf('/');
  if (slash <= 0) return null;
  return refId.slice(0, slash).toLowerCase();
}

/**
 * The Graph object id of a refId — everything after `${upn}/${kind}/`,
 * chunk suffix included if present. Null when the ref is malformed. The
 * override flow (a mailbox owner correcting their own message) uses this to
 * recover the id to re-fetch, since bodies are never persisted at rest.
 */
export function objectIdOfMicrosoftRefId(refId: string): string | null {
  const firstSlash = refId.indexOf('/');
  if (firstSlash <= 0) return null;
  const secondSlash = refId.indexOf('/', firstSlash + 1);
  if (secondSlash === -1) return null;
  const id = refId.slice(secondSlash + 1);
  return id || null;
}
