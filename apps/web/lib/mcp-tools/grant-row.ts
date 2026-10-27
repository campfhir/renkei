import { getDataStore } from '@renkei/db';

/**
 * A person's first grant on one provider (by account id), scopes only — read
 * through the data store, never decrypted. The registry, the tool catalog
 * and the Jira administration gates all ask this.
 */
export async function grantRow(
  provider: string,
  subject: string
): Promise<
  | { provider_account_id: string; requested_scopes: string[]; granted_scopes: string[] | null }
  | undefined
> {
  const [grant] = await getDataStore().providerGrants.listForSubject(subject, { provider });
  return grant
    ? {
        provider_account_id: grant.accountId,
        requested_scopes: grant.requestedScopes,
        granted_scopes: grant.grantedScopes,
      }
    : undefined;
}
