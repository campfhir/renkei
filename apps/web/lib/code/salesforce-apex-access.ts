/**
 * Whether a code project's chat offers the Apex tools
 * (salesforce-apex-tools.ts): the person holds a Salesforce Admin
 * connection with the Apex capability, and the organization has not
 * switched Salesforce Admin off or gone read-only. Each call still checks
 * the one connection it runs on — this only decides whether the tools are
 * offered at all.
 */

import { getDataStore } from '@renkei/db';
import { SALESFORCE_ADMIN } from '@renkei/provider-grants';
import { getOrgSettings } from '@renkei/settings';
import { narrowedScopes } from '@/lib/mcp-tools/narrowed-scopes';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';

export const APEX_SCOPE = 'sfa-apex';

export async function salesforceApexAvailable(subject: string): Promise<boolean> {
  const settings = await getOrgSettings();
  if (!settings.ok || settings.val.readOnly) return false;
  if (settings.val.disabledConnectors.includes(SALESFORCE_ADMIN_KIND.key)) return false;
  const grants = await getDataStore().providerGrants.listForSubject(subject, {
    provider: SALESFORCE_ADMIN,
  });
  return grants.some((grant) =>
    narrowedScopes(grant.requestedScopes, grant.grantedScopes).includes(APEX_SCOPE)
  );
}
