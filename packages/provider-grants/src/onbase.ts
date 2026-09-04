/**
 * The OnBase implementations of ProviderAdapter — two of them, one per
 * Hyland connector (RENKEI.md Decision #9: Renkei talks to OnBase's
 * Document Management API and its Administration API as two separate
 * connectors, exactly as Jira/JSM/Confluence/Bitbucket are four separate
 * Atlassian connectors — because they genuinely are separate OAuth clients
 * on the customer's Hyland IdP, connected and revoked independently).
 *
 * OnBase tokens come from a customer-hosted Hyland IdP that the web process
 * deliberately never dials — every request to it goes through the OnBase
 * egress worker. So unlike the SaaS adapters, these do no HTTP of their
 * own: the caller constructs one with a refresh closure that speaks to the
 * worker, and the adapter's job is only to fit that closure into the generic
 * grant lifecycle (locking, revoked-grant cleanup, rotation storage).
 *
 * The `clientId` parameter is unused: the worker resolves the tenant's
 * stored IdP registration (issuer, client id, optional secret) itself, so a
 * caller cannot point the refresh at a different client.
 */

import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

/** The Document Management API connector — search, read, file documents. */
export const ONBASE = 'onbase';
/** The Administration API connector — document types, keyword types, etc. */
export const ONBASE_ADMIN = 'onbase-admin';

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

export class OnBaseAdminAdapter implements ProviderAdapter {
  readonly provider = ONBASE_ADMIN;

  constructor(private readonly refresh: OnBaseRefresh) {}

  refreshTokens(
    _clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    return this.refresh(refreshToken);
  }
}
