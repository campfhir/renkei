/**
 * Deep links into the Entra admin center, for the parts of provisioning
 * Renkei deliberately does not do through Graph: minting a client secret
 * (the value would have to travel back through a model's transcript) and
 * granting admin consent (a tenant-wide decision a person should make on
 * Microsoft's own screen). The tools show these beside their answers so
 * "where do I add a secret?" is one click, not a search.
 *
 * Blade ids are the portal's own (`ApplicationMenuBlade/~/<blade>`), the
 * same ones portal.azure.com uses; entra.microsoft.com serves them all.
 */

const PORTAL = 'https://entra.microsoft.com/#view';

function appBlade(appId: string, blade: string): string {
  return `${PORTAL}/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/${blade}/appId/${encodeURIComponent(appId)}`;
}

function enterpriseBlade(objectId: string, appId: string, blade: string): string {
  return `${PORTAL}/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/${blade}/objectId/${encodeURIComponent(objectId)}/appId/${encodeURIComponent(appId)}`;
}

export interface PortalLink {
  label: string;
  url: string;
}

/** An app registration's blades, in the order the portal lists them. */
export function applicationLinks(appId: string): PortalLink[] {
  return [
    { label: 'Overview', url: appBlade(appId, 'Overview') },
    {
      label: 'Authentication (redirect URIs, token settings)',
      url: appBlade(appId, 'Authentication'),
    },
    { label: 'Certificates & secrets (add a client secret)', url: appBlade(appId, 'Credentials') },
    { label: 'API permissions (grant admin consent)', url: appBlade(appId, 'CallAnAPI') },
    { label: 'Expose an API', url: appBlade(appId, 'Oauth2Permissions') },
    { label: 'App roles', url: appBlade(appId, 'AppRoles') },
    { label: 'Owners', url: appBlade(appId, 'Owners') },
  ];
}

/** An enterprise application's blades. */
export function enterpriseApplicationLinks(objectId: string, appId: string): PortalLink[] {
  return [
    { label: 'Overview', url: enterpriseBlade(objectId, appId, 'Overview') },
    { label: 'Users and groups', url: enterpriseBlade(objectId, appId, 'Users') },
    {
      label: 'Permissions (admin consent granted)',
      url: enterpriseBlade(objectId, appId, 'Permissions'),
    },
    {
      label: 'Properties (assignment required, visibility)',
      url: enterpriseBlade(objectId, appId, 'Properties'),
    },
  ];
}

export const secretsLink = (appId: string): string => appBlade(appId, 'Credentials');
export const apiPermissionsLink = (appId: string): string => appBlade(appId, 'CallAnAPI');

export function linkLines(heading: string, links: PortalLink[]): string[] {
  return [heading, ...links.map((link) => `  • ${link.label}: ${link.url}`)];
}
