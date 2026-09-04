/**
 * `provider_grants.provider` keys → the names people know them by.
 *
 * The connector catalog maps UI entries to config/capability keys; this is
 * the third identifier (grantProvider) rendered for humans. 'microsoft' is
 * one grant that powers Outlook, SharePoint and OneDrive, so its label says
 * the platform rather than picking one product. Pure data, client-safe.
 */

export const GRANT_PROVIDER_LABELS: Record<string, string> = {
  atlassian: 'Jira',
  'atlassian-jsm': 'Jira Service Management',
  'atlassian-confluence': 'Confluence',
  microsoft: 'Microsoft 365',
  webex: 'WebEx',
  zoom: 'Zoom',
  onbase: 'OnBase',
  'onbase-admin': 'OnBase Administration',
};

export function grantProviderLabel(provider: string): string {
  return GRANT_PROVIDER_LABELS[provider] ?? provider;
}
