/**
 * The OnBase implementation of ProviderAdapter.
 *
 * OnBase tokens come from a customer-hosted Hyland IdP that the web process
 * deliberately never dials — every request to it goes through the OnBase
 * egress worker. So unlike the SaaS adapters, this one does no HTTP of its
 * own: the caller constructs it with a refresh closure that speaks to the
 * worker, and the adapter's job is only to fit that closure into the generic
 * grant lifecycle (locking, revoked-grant cleanup, rotation storage).
 *
 * The `clientId` parameter is unused: the worker resolves the tenant's
 * stored IdP registration (issuer, client id, optional secret) itself, so a
 * caller cannot point the refresh at a different client.
 */

import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const ONBASE = 'onbase';

export type OnBaseRefresh = (
  refreshToken: string
) => Promise<Result<RefreshedTokens, RefreshError>>;

export class OnBaseAdapter implements ProviderAdapter {
  readonly provider = ONBASE;

  constructor(private readonly refresh: OnBaseRefresh) {}

  refreshTokens(
    _clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    return this.refresh(refreshToken);
  }
}
