/**
 * How the salesforce_ tools reach Salesforce — injected, not resolved
 * inline, the EntraAuth shape: sfRequest takes an `access` separate from
 * resolving one, so resolving is the only thing that needs to be
 * swappable. Capability enforcement stays at registration, via
 * salesforceScopeFor + withScopeGate in index.ts.
 */

import {
  resolveSalesforceAccess,
  type SalesforceAccess,
  type SalesforceCallContext,
} from './client';

export interface SalesforceAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /** The credential for one call, or a human-readable reason there is none. */
  resolve(): Promise<SalesforceAccess | string>;
}

/** Production's only implementation: the caller's own Salesforce grant. */
export function oauthSalesforceAuth(context: SalesforceCallContext): SalesforceAuth {
  return {
    kind: 'oauth',
    resolve: () => resolveSalesforceAccess(context),
  };
}

/** For suites that register the tools with no grant behind them. */
export function deniedSalesforceAuth(): SalesforceAuth {
  return {
    kind: 'denied',
    resolve: async () =>
      'No Salesforce credential is configured for this connector — this call is always denied, ' +
      'on purpose, to prove the tools handle that instead of crashing.',
  };
}
