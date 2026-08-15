/**
 * How the sharepoint_ and onedrive_ tools reach Microsoft Graph — injected,
 * not resolved inline.
 *
 * This interface is deliberately NARROWER than JsmOpsAuth/WebexAuth/ZoomAuth,
 * and that is a real design decision, not an inconsistency:
 *
 *   1. graphGet/graphPost/graphPatch/graphPut/graphDelete/graphPutContent
 *      (client.ts) already take an access TOKEN as an explicit parameter,
 *      separate from resolving one — unlike jiraFetch or the webex/zoom
 *      fetch helpers, which read the credential and made the network call in
 *      one function. Graph's client was already split the right way; the
 *      only thing that needed to become swappable is resolveGraphAccess
 *      itself, so GraphAuth wraps exactly that and nothing else. Forcing the
 *      five Graph verbs through a single fetch(scopes, path, init) — the
 *      other three connectors' shape — would mean rebuilding typed
 *      conveniences (an auto-serialized json body, raw-byte uploads with
 *      their own content type) as raw RequestInit at every one of the ~30
 *      call sites across sites.ts/pages.ts/metadata.ts/watches.ts/
 *      documents.ts, for no real gain.
 *
 *   2. resolve() takes no requiredScopes parameter, unlike the other three
 *      connectors' fetch(). OneDrive's own scope model is NOT tool-keyed —
 *      see onedrive/scopes.ts: the same onedrive_rename_document needs
 *      Files.ReadWrite for the caller's own file and Files.ReadWrite.All for
 *      one shared with them, a distinction resolved per ITEM, discovered
 *      only after resolve() already returned and the target item is looked
 *      up. A call-time check keyed by tool name alone would be wrong here,
 *      not just redundant with registration-time withScopeGate the way it
 *      would be incidentally redundant for Ops. Call-time scope enforcement
 *      for Graph stays at registration only, correctly, for this reason.
 *
 * Same eventual-sandbox story as WebEx/Zoom otherwise: Graph is
 * delegated-OAuth-only with no personal-token equivalent, so `deniedGraphAuth`
 * stands in until a sandbox credential exists — see
 * sharepoint/onedrive "no-sandbox" suites.
 */

import { resolveGraphAccess, type GraphAccess, type GraphCallContext } from './client';

export interface GraphAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /**
   * Resolve the credential for one call. Returns the same GraphAccess |
   * string union resolveGraphAccess always returned — a human-readable
   * denial string, not a thrown error or a synthetic Response — so every
   * call site's existing `if (typeof access === 'string') return
   * errText(access)` needs no change beyond calling auth.resolve() instead
   * of the free function directly.
   */
  resolve(): Promise<GraphAccess | string>;
}

/** Production's only implementation: the caller's own Microsoft grant. */
export function oauthGraphAuth(context: GraphCallContext): GraphAuth {
  return {
    kind: 'oauth',
    resolve: () => resolveGraphAccess(context),
  };
}

/**
 * The other implementation, for when no Microsoft sandbox exists to run
 * `oauthGraphAuth` against for real. See webex-auth.ts's `deniedWebexAuth`
 * for the full reasoning — identical here. Graph has no personal-token
 * equivalent at all (delegated OAuth only, via MSAL), so there is no PAT
 * escape hatch the way Jira's Ops API had one.
 */
export function deniedGraphAuth(): GraphAuth {
  return {
    kind: 'denied',
    resolve: async () =>
      'No Microsoft test credential is configured for this connector yet — this call is always ' +
      'denied, on purpose, to prove the tools handle that instead of crashing.',
  };
}
