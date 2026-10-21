/**
 * The two Salesforce connector types — CRM (`salesforce`) and admin
 * (`salesforce-admin`) — as data, so one set of helpers, routes and forms
 * serves both: each has its own config row (its list of per-org
 * connectors), its own grant provider, its own connect and disconnect
 * routes, its own capability catalog and its own label. Everything else —
 * one connector per org, the My Domain checks, host pinning — is the same
 * (docs/salesforce-connectors-design.md).
 *
 * Client-safe: no server imports, so the admin form and the cards can take
 * a kind too.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import {
  ALL_SALESFORCE_SCOPES,
  DEFAULT_SALESFORCE_SCOPES,
  SALESFORCE_SCOPE_GROUPS,
  SALESFORCE_SCOPE_OPTIONS,
  usableSalesforceCeiling,
} from '@/lib/salesforce-scopes';
import {
  ALL_SALESFORCE_ADMIN_SCOPES,
  DEFAULT_SALESFORCE_ADMIN_SCOPES,
  SALESFORCE_ADMIN_SCOPE_GROUPS,
  SALESFORCE_ADMIN_SCOPE_OPTIONS,
  usableSalesforceAdminCeiling,
} from '@/lib/salesforce-admin-scopes';

export type SalesforceKindKey = 'salesforce' | 'salesforce-admin';

export interface SalesforceKind {
  /** The connector config row and the catalog's capability key. */
  key: SalesforceKindKey;
  /** The provider_grants provider. */
  provider: string;
  /** "Salesforce", "Salesforce Admin". */
  label: string;
  /** Connect and disconnect: `${apiBase}/<connector>/authorize|grant`. */
  apiBase: string;
  /** The admin API for this type's connectors. */
  adminApi: string;
  scopeGroups: ScopeGroup[];
  scopeOptions: ScopeOption[];
  allScopes: string[];
  /** Space-separated. */
  defaultScopes: string;
  ceiling(stored: string | null | undefined): string[];
}

export const SALESFORCE_CRM_KIND: SalesforceKind = {
  key: 'salesforce',
  provider: 'salesforce',
  label: 'Salesforce',
  apiBase: '/api/salesforce',
  adminApi: '/api/admin/connectors/salesforce',
  scopeGroups: SALESFORCE_SCOPE_GROUPS,
  scopeOptions: SALESFORCE_SCOPE_OPTIONS,
  allScopes: ALL_SALESFORCE_SCOPES,
  defaultScopes: DEFAULT_SALESFORCE_SCOPES,
  ceiling: usableSalesforceCeiling,
};

export const SALESFORCE_ADMIN_KIND: SalesforceKind = {
  key: 'salesforce-admin',
  provider: 'salesforce-admin',
  label: 'Salesforce Admin',
  apiBase: '/api/salesforce-admin',
  adminApi: '/api/admin/connectors/salesforce-admin',
  scopeGroups: SALESFORCE_ADMIN_SCOPE_GROUPS,
  scopeOptions: SALESFORCE_ADMIN_SCOPE_OPTIONS,
  allScopes: ALL_SALESFORCE_ADMIN_SCOPES,
  defaultScopes: DEFAULT_SALESFORCE_ADMIN_SCOPES,
  ceiling: usableSalesforceAdminCeiling,
};

/** The kind a grant provider (or a pending sign-in's provider) belongs to, or null. */
export function salesforceKindOfProvider(provider: string): SalesforceKind | null {
  if (provider === SALESFORCE_CRM_KIND.provider) return SALESFORCE_CRM_KIND;
  if (provider === SALESFORCE_ADMIN_KIND.provider) return SALESFORCE_ADMIN_KIND;
  return null;
}
