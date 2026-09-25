/**
 * How the entra_ tools reach Graph — injected, not resolved inline, the
 * GraphAuth / JiraAdminAuth shape: entraRequest (client.ts) takes an
 * `access` separate from resolving one, so resolving is the only thing
 * that needs to be swappable. Scope enforcement stays at registration, via
 * entraScopeFor + withScopeGate in index.ts.
 */

import { resolveEntraAccess, type EntraAccess, type EntraCallContext } from './client';

export interface EntraAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /** The credential for one call, or a human-readable reason there is none. */
  resolve(): Promise<EntraAccess | string>;
}

/** Production's only implementation: the caller's own Entra Developer grant. */
export function oauthEntraAuth(context: EntraCallContext): EntraAuth {
  return {
    kind: 'oauth',
    resolve: () => resolveEntraAccess(context),
  };
}

/** For suites that register the tools with no grant behind them. */
export function deniedEntraAuth(): EntraAuth {
  return {
    kind: 'denied',
    resolve: async () =>
      'No Entra Developer credential is configured for this connector — this call is always ' +
      'denied, on purpose, to prove the tools handle that instead of crashing.',
  };
}
