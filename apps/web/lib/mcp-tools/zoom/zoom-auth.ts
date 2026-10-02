/**
 * How zoom_* tools reach the Zoom API — injected, not resolved inline.
 *
 * Same shape and same reasoning as webex/webex-auth.ts: no personal-token
 * equivalent exists for Zoom either, so the eventual sandbox implementation
 * will still be `oauthZoomAuth`-shaped, just closing over a stored sandbox
 * credential instead of a live per-request grant lookup. `deniedZoomAuth` is
 * the stand-in until that credential exists — see zoom.no-sandbox.test.ts.
 *
 * Two tools — zoom_get_transcript and zoom_get_meeting_summary — construct
 * a `ZoomClient` from @renkei/connector-zoom directly rather than going
 * through ZoomAuth.fetch(), because the client's own request layer (lane
 * limiting, VTT download) is what they want. They resolve the caller's
 * grant via `resolveZoomAccess` and hand the client the same `AuthedFetch`
 * this module sends its own calls through — see index.ts.
 *
 * No token is read here (docs/delegate-key-design.md): the fetcher comes
 * from the delegate, which attaches the credential, refreshes it when due
 * and retries once on a 401.
 */

import { ZOOM } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { grantRefusalText, refusalTextOf } from '@/lib/grant-refusals';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { authFailure } from '../auth-support';

/** Exported so index.ts's two ZoomClient-based tools can share it — see this file's header. */
export const ZOOM_API_BASE = 'https://api.zoom.us/v2';
const API = ZOOM_API_BASE;
const LABEL = 'Zoom';

export interface ZoomAccess {
  /** `fetch` on the caller's own Zoom grant; the delegate supplies the credential. */
  auth: AuthedFetch;
  email: string | null;
}

/**
 * The caller's Zoom grant as a fetcher, plus the account email the grant
 * recorded. Resolved FRESH on every call — see WebEx's identical note on
 * why no module-level cache exists here. Exported for the summary
 * collectors AND for the two ZoomClient-based tools in index.ts.
 */
export async function resolveZoomAccess(
  context: Pick<MCPToolContext, 'tenantId' | 'subject'>
): Promise<ZoomAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const grant = { tenantId: context.tenantId, provider: ZOOM, subject: context.subject };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) return grantRefusalText(described.err.type, LABEL);
  const email =
    typeof described.val.metadata.email === 'string' ? described.val.metadata.email : null;
  return { auth: grantFetch(grant), email };
}

export interface ZoomAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /**
   * Perform one Zoom API call, after confirming this credential carries
   * `requiredScopes`. Same wrapping-the-call reasoning as every other
   * XAuth in this codebase — see JsmOpsAuth's fuller note.
   *
   * `path` is relative to https://api.zoom.us/v2.
   */
  fetch(requiredScopes: readonly string[], path: string, init?: RequestInit): Promise<Response>;
}

function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/** Production's only implementation: the caller's own Zoom user grant. */
export function oauthZoomAuth(context: MCPToolContext): ZoomAuth {
  // Scope nuance unique to Zoom: a classic-scope Marketplace app ignores the
  // authorize request's scope parameter and mints its full scope set, so
  // context.zoomScopes already arrives as requested ∩ granted — computed by
  // the OAuth callback route, not here. See index.ts's original header.
  const granted = context.zoomScopes;

  return {
    kind: 'oauth',
    async fetch(requiredScopes, path, init) {
      if (granted !== undefined) {
        const missing = requiredScopes.filter((scope) => !granted.includes(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which your Zoom grant does not carry. The ` +
              'org admin adds it to the Marketplace app, then you disconnect and reconnect Zoom.',
            403
          );
        }
      }

      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return authFailure(access, 400);

      const body = init?.body !== undefined ? init.body : undefined;
      const method = init?.method ?? 'GET';
      let response: Response;
      try {
        response = await access.auth(`${API}${path}`, {
          ...init,
          method,
          headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...init?.headers,
          },
        });
      } catch {
        logger.warn('Zoom API unreachable', {
          component: 'zoom/fetch',
          tenantId: context.tenantId,
          subject: context.subject,
          path,
          method,
        });
        return authFailure('Could not reach api.zoom.us');
      }

      // The delegate refusing (grant gone, token unrefreshable, delegate
      // down) is not a Zoom answer; it comes back in the resolvers' words.
      const refused = refusalTextOf(response, LABEL);
      if (refused) return authFailure(refused, 400);

      if (!response.ok) {
        const responseBody = await response
          .clone()
          .text()
          .catch(() => '');
        logger.warn('Zoom API non-OK response', {
          component: 'zoom/fetch',
          tenantId: context.tenantId,
          subject: context.subject,
          path,
          method,
          status: response.status,
          requestBody: typeof body === 'string' ? secure(truncateForLog(body)) : undefined,
          responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
        });
      }
      return response;
    },
  };
}

/**
 * The other implementation, for when no Zoom sandbox exists to run
 * `oauthZoomAuth` against for real. See webex-auth.ts's `deniedWebexAuth`
 * for the full reasoning — identical here.
 */
export function deniedZoomAuth(): ZoomAuth {
  return {
    kind: 'denied',
    async fetch() {
      return authFailure(
        'No Zoom test credential is configured for this connector yet — this call is always ' +
          'denied, on purpose, to prove the tools handle that instead of crashing.',
        401
      );
    },
  };
}
