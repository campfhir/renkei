/**
 * How the fabric_ tools reach Fabric — injected, not resolved inline, the
 * EntraAuth shape: resolving is the only thing a suite needs to swap.
 * Scope enforcement stays at registration (fabricScopeFor + withScopeGate).
 */

import { resolveFabricAccess, type FabricAccess, type FabricCallContext } from './client';

export interface FabricAuth {
  readonly kind: 'oauth' | 'denied';
  resolve(): Promise<FabricAccess | string>;
}

/** Production's only implementation: the caller's own Fabric grant. */
export function oauthFabricAuth(context: FabricCallContext): FabricAuth {
  return { kind: 'oauth', resolve: () => resolveFabricAccess(context) };
}
