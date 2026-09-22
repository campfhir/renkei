/**
 * How the github_ tools reach GitHub — injected, not resolved inline. The
 * full GitHubAuth shape mirrors BitbucketAuth: fetch(requiredScopes,
 * path, init) wraps the call-time capability check around the real call,
 * and the same mapping (./scopes.ts) gates registration via withScopeGate
 * — one mapping, two enforcement points that cannot drift apart.
 *
 * Unlike JSM's jiraFetch, the Response here is the provider's real
 * answer, ok or not: a non-2xx status can be GitHub's own (rendered by
 * describeGitHubFailure) or this module's local denial (authFailure) —
 * both carry a {message} body, so one render path serves both.
 */

import { authFailure } from '../auth-support';
import { resolveGitHubAccess, githubRequest } from './client';
import type { MCPToolContext } from '../common';

export interface GitHubAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth';
  fetch(
    requiredScopes: readonly string[],
    pathAndQuery: string,
    init?: { method?: string; json?: unknown; accept?: string }
  ): Promise<Response>;
}

/** Production's only implementation: the caller's own GitHub grant. */
export function oauthGitHubAuth(context: MCPToolContext): GitHubAuth {
  const granted = context.githubScopes === undefined ? null : new Set(context.githubScopes);
  return {
    kind: 'oauth',
    async fetch(requiredScopes, pathAndQuery, init) {
      if (granted) {
        const missing = requiredScopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which this connection does not carry. ` +
              `Reconnect GitHub with that capability enabled.`,
            403
          );
        }
      }
      const access = await resolveGitHubAccess(context);
      if (typeof access === 'string') return authFailure(access, 401);
      const result = await githubRequest(
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
