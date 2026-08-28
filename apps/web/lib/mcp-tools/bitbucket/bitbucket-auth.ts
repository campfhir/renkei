/**
 * How the bitbucket_ tools reach Bitbucket Cloud — injected, not resolved
 * inline. The full JsmAuth shape: fetch(requiredScopes, path, init) wraps
 * the call-time scope check around the real call, and the same mapping
 * (./scopes.ts) gates registration via withScopeGate — one mapping, two
 * enforcement points that cannot drift apart.
 *
 * Unlike JSM's jiraFetch, the Response here is the provider's real answer,
 * ok or not: a non-2xx status can be Bitbucket's own (rendered by
 * describeBitbucketFailure) or this module's local denial (authFailure) —
 * both carry a {message} body, so one render path serves both.
 */

import { authFailure } from '../auth-support';
import { resolveBitbucketAccess, bitbucketRequest } from './client';
import type { MCPToolContext } from '../common';

export interface BitbucketAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'pat';
  fetch(
    requiredScopes: readonly string[],
    pathAndQuery: string,
    init?: { method?: string; json?: unknown; form?: URLSearchParams; accept?: string }
  ): Promise<Response>;
}

/** Production's only implementation: the caller's own Bitbucket grant. */
export function oauthBitbucketAuth(context: MCPToolContext): BitbucketAuth {
  const granted =
    context.bitbucketScopes === undefined ? null : new Set(context.bitbucketScopes);
  return {
    kind: 'oauth',
    async fetch(requiredScopes, pathAndQuery, init) {
      if (granted) {
        const missing = requiredScopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which this connection does not carry. ` +
              `Reconnect Bitbucket with that capability enabled (the OAuth consumer on ` +
              `bitbucket.org must carry it too).`,
            403
          );
        }
      }
      const access = await resolveBitbucketAccess(context);
      if (typeof access === 'string') return authFailure(access, 401);
      const result = await bitbucketRequest(
        { tenantId: context.tenantId, subject: context.subject },
        access,
        pathAndQuery,
        init
      );
      if (!result.ok) return authFailure(result.error, 502);
      return result.response;
    },
  };
}
