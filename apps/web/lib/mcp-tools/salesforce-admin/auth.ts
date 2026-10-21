/**
 * How the salesforce_admin_ tools reach Salesforce: the caller's own grant
 * on the admin connector (org) the call acts in — the CRM's resolution
 * (salesforce/client.ts) on the admin type's connectors, grants and
 * capability map.
 */

import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { resolveSalesforceAccess, type SalesforceCallContext } from '../salesforce/client';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { salesforceAdminScopeFor } from './scopes';

export function oauthSalesforceAdminAuth(context: SalesforceCallContext): SalesforceAuth {
  return {
    kind: 'oauth',
    resolve: () => resolveSalesforceAccess(context, SALESFORCE_ADMIN_KIND, salesforceAdminScopeFor),
  };
}
