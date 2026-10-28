/**
 * What the delegate knows about each OAuth provider: which connector
 * config holds the app registration (client id, client secret, directory
 * tenant), how to build the refresh adapter, where its token endpoint is,
 * and which hosts a proxied request may be sent to with that provider's
 * token attached. The host list is the whole point of a proxy that
 * injects credentials: a caller names a URL, and the token goes only to
 * the provider it belongs to.
 */

import { getDataStore, memoryDataStoreRequested } from '@renkei/db';
import { readConnectorConfigCached, type ConnectorConfig } from '@renkei/connector-config';
import {
  getServer,
  getSealedClientSecret,
  serverIdOfProvider,
  tokenClientAuth,
} from '@renkei/connector-mcp';
import { decrypt } from '@renkei/crypto';
import {
  ATLASSIAN,
  ATLASSIAN_ADMIN,
  ATLASSIAN_ADMIN_TOKEN,
  ATLASSIAN_BITBUCKET,
  ATLASSIAN_CONFLUENCE,
  ATLASSIAN_JSM,
  AtlassianAdapter,
  BitbucketAdapter,
  ENTRA_DEVELOPER,
  GenericOAuthAdapter,
  GITHUB,
  GitHubAdapter,
  MICROSOFT,
  MicrosoftAdapter,
  ONBASE,
  ONBASE_ADMIN,
  OnBaseAdapter,
  OnBaseAdminAdapter,
  SALESFORCE,
  SALESFORCE_ADMIN,
  SalesforceAdapter,
  readSalesforceMetadata,
  salesforceTokenEndpoint,
  WEBEX_USER,
  WebexUserAdapter,
  ZOOM,
  ZoomAdapter,
  type ProviderAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import {
  findOrg,
  orgForInstance,
  orgSecretName,
  orgsFromSettings,
  type SalesforceOrg,
} from '@renkei/connector-salesforce';
import { onbaseWorkerRefresh } from './onbase-worker';

export interface ProviderSpec {
  /** The connector_configs row the app registration lives in. */
  connector: string;
  /** The OAuth token endpoint an `exchange` may post to; null when a worker does it (OnBase). */
  tokenEndpoint: string | null;
  /** Hostnames a request may carry this provider's token to. A leading dot allows subdomains. */
  hosts: readonly string[];
  /**
   * More hosts, for a provider whose API lives on the customer's own host
   * (Salesforce's My Domain, one per org): for a stored grant, the host of
   * the org it was minted in; for a pending exchange, the host the token
   * answer named — each only when the app registration lists that org.
   * Exact hosts only, never a suffix (for Salesforce, every org on earth).
   */
  hostsFor?(
    config: ConnectorConfig | null,
    grant: ProviderGrant | null,
    pendingInstanceUrl: string | null
  ): string[];
  /** The token endpoint, when it is the customer's own host too; `org` names which. */
  tokenEndpointFrom?(config: ConnectorConfig | null, org?: string): string | null;
  /** The client credentials an exchange presents, when they vary by org. */
  credentialsFor?(
    config: ConnectorConfig | null,
    org?: string
  ): { clientId: string; clientSecret: string };
  /** How the token endpoint wants the client authenticated at exchange time. */
  clientAuth: 'body' | 'basic' | 'none';
  /**
   * Exact origins a request may go to, in addition to `hosts`. A dynamic
   * provider (a remote MCP server) knows its one origin from its row, and
   * may be a loopback http origin in development.
   */
  origins?: readonly string[];
  /** The app registration, when it is not a `connector_configs` row (an MCP server's own). */
  staticConfig?: ConnectorConfig;
  /** An open server (no authorization): requests go out with no credential at all. */
  anonymous?: boolean;
  /**
   * A credential the person typed in rather than one an OAuth exchange
   * minted: stored by `grant/store` (never `oauth/exchange` + `grant/commit`),
   * never refreshed, and sent as HTTP Basic with the grant's `metadata.email`
   * as the user name — an Atlassian API token, for the Automation API that
   * refuses OAuth apps. The web app validates it by making a call through
   * the delegate, not by holding it.
   */
  credential?: 'basic';
  /** Where a disconnect may revoke the token, when the provider offers one. */
  revocationEndpoint?: string;
  adapter(config: ConnectorConfig | null, grant: ProviderGrant | null): ProviderAdapter | null;
}

function secretOf(config: ConnectorConfig | null): string {
  return typeof config?.secrets.clientSecret === 'string' ? config.secrets.clientSecret : '';
}

function settingOf(config: ConnectorConfig | null, key: string): string {
  const value = config?.settings[key];
  return typeof value === 'string' ? value : '';
}

const ATLASSIAN_HOSTS = ['api.atlassian.com', 'auth.atlassian.com'];

function atlassian(provider: string): ProviderSpec {
  return {
    connector: provider,
    tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
    hosts: ATLASSIAN_HOSTS,
    clientAuth: 'body',
    adapter: (config) =>
      secretOf(config) ? new AtlassianAdapter(secretOf(config), provider) : null,
  };
}

function microsoft(provider: string): ProviderSpec {
  return {
    connector: provider,
    tokenEndpoint: null, // per directory tenant; resolved by `tokenEndpointFor`
    hosts: ['graph.microsoft.com', 'login.microsoftonline.com'],
    clientAuth: 'body',
    adapter: (config, grant) => {
      const tid =
        typeof grant?.metadata.tid === 'string' && grant.metadata.tid
          ? grant.metadata.tid
          : settingOf(config, 'directoryTenantId');
      return secretOf(config) && tid ? new MicrosoftAdapter(secretOf(config), tid, provider) : null;
    },
  };
}

/** The orgs a Salesforce app registration lists (production and sandboxes). */
export function salesforceOrgs(config: ConnectorConfig | null): SalesforceOrg[] {
  return orgsFromSettings(config?.settings);
}

/** The registered org a Salesforce grant was minted in, or null. */
export function salesforceOrgOfGrant(
  config: ConnectorConfig | null,
  grant: ProviderGrant | null
): SalesforceOrg | null {
  if (!grant) return null;
  return orgForInstance(salesforceOrgs(config), readSalesforceMetadata(grant.metadata).instanceUrl);
}

/** A connector's own consumer key and secret (each org is its own External Client App). */
function salesforceCredentials(
  config: ConnectorConfig | null,
  org: SalesforceOrg | null
): { clientId: string; clientSecret: string } {
  if (!org) return { clientId: '', clientSecret: '' };
  return { clientId: org.clientId, clientSecret: config?.secrets[orgSecretName(org.key)] ?? '' };
}

/** A connector the admin has switched on, by key. */
function enabledOrg(config: ConnectorConfig | null, key: string | undefined): SalesforceOrg | null {
  const org = key ? findOrg(salesforceOrgs(config), key) : null;
  return org?.enabled ? org : null;
}

function salesforce(provider: string): ProviderSpec {
  return {
    connector: provider,
    tokenEndpoint: null, // the org's own; resolved by `tokenEndpointFor`
    hosts: [],
    hostsFor: (config, grant, pendingInstanceUrl) => {
      const orgs = salesforceOrgs(config);
      const org = grant
        ? orgForInstance(orgs, readSalesforceMetadata(grant.metadata).instanceUrl)
        : pendingInstanceUrl
          ? orgForInstance(orgs, pendingInstanceUrl)
          : null;
      // A connector switched off carries nothing, even for an existing grant.
      return org?.enabled ? [org.host] : [];
    },
    tokenEndpointFrom: (config, key) => {
      const org = enabledOrg(config, key);
      return org ? salesforceTokenEndpoint(org.myDomain) : null;
    },
    credentialsFor: (config, key) => salesforceCredentials(config, enabledOrg(config, key)),
    clientAuth: 'body',
    adapter: (config, grant) => {
      const org = salesforceOrgOfGrant(config, grant);
      if (!org?.enabled) return null;
      const { clientSecret } = salesforceCredentials(config, org);
      return clientSecret
        ? new SalesforceAdapter(clientSecret, salesforceTokenEndpoint(org.myDomain), provider)
        : null;
    },
  };
}

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  [ATLASSIAN]: atlassian(ATLASSIAN),
  [ATLASSIAN_JSM]: atlassian(ATLASSIAN_JSM),
  [ATLASSIAN_CONFLUENCE]: atlassian(ATLASSIAN_CONFLUENCE),
  [ATLASSIAN_ADMIN]: atlassian(ATLASSIAN_ADMIN),
  // The person's own Atlassian API token, beside their Jira Administration
  // grant and switched off with it (the same connector row): Basic auth to
  // api.atlassian.com, for the Automation API, which refuses OAuth apps.
  [ATLASSIAN_ADMIN_TOKEN]: {
    connector: ATLASSIAN_ADMIN,
    tokenEndpoint: null,
    hosts: ['api.atlassian.com'],
    clientAuth: 'none',
    credential: 'basic',
    adapter: () => null,
  },
  [ATLASSIAN_BITBUCKET]: {
    connector: ATLASSIAN_BITBUCKET,
    tokenEndpoint: 'https://bitbucket.org/site/oauth2/access_token',
    hosts: ['api.bitbucket.org', 'bitbucket.org'],
    clientAuth: 'basic',
    adapter: (config) => (secretOf(config) ? new BitbucketAdapter(secretOf(config)) : null),
  },
  [GITHUB]: {
    connector: GITHUB,
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    hosts: ['api.github.com', 'github.com', '.githubusercontent.com'],
    clientAuth: 'body',
    adapter: (config) => (secretOf(config) ? new GitHubAdapter(secretOf(config)) : null),
  },
  [MICROSOFT]: microsoft(MICROSOFT),
  [ENTRA_DEVELOPER]: microsoft(ENTRA_DEVELOPER),
  [WEBEX_USER]: {
    connector: 'webex-user',
    tokenEndpoint: 'https://webexapis.com/v1/access_token',
    hosts: ['webexapis.com'],
    clientAuth: 'body',
    adapter: (config) => (secretOf(config) ? new WebexUserAdapter(secretOf(config)) : null),
  },
  [ZOOM]: {
    connector: ZOOM,
    tokenEndpoint: 'https://zoom.us/oauth/token',
    hosts: ['api.zoom.us', 'zoom.us', '.zoom.us'],
    clientAuth: 'basic',
    adapter: (config) => (secretOf(config) ? new ZoomAdapter(secretOf(config)) : null),
  },
  [SALESFORCE]: salesforce(SALESFORCE),
  // The admin connector: its own config row and External Client Apps, the same host rules.
  [SALESFORCE_ADMIN]: salesforce(SALESFORCE_ADMIN),
  [ONBASE]: {
    connector: ONBASE,
    tokenEndpoint: null,
    hosts: [],
    clientAuth: 'body',
    adapter: () => new OnBaseAdapter(onbaseWorkerRefresh(ONBASE)),
  },
  [ONBASE_ADMIN]: {
    connector: ONBASE_ADMIN,
    tokenEndpoint: null,
    hosts: [],
    clientAuth: 'body',
    adapter: () => new OnBaseAdminAdapter(onbaseWorkerRefresh(ONBASE_ADMIN)),
  },
};

/**
 * The spec for any provider, including the dynamic ones: `mcp:<server id>`
 * is built from that server's row — its origin is the only host its token
 * may reach, and the token endpoint and client came out of its own
 * authorization discovery (docs/mcp-connector-design.md). A disabled or
 * unknown server has no spec, so nothing of it is dialed.
 */
export async function resolveProviderSpec(
  encryptionKey: Buffer,
  provider: string
): Promise<ProviderSpec | null> {
  const fixed = providerSpec(provider);
  if (fixed) return fixed;
  const serverId = serverIdOfProvider(provider);
  if (!serverId) return null;
  const read = await getServer(serverId);
  if (!read.ok || !read.val || !read.val.enabled) return null;
  const server = read.val;
  let secret = '';
  const sealed = await getSealedClientSecret(serverId);
  if (sealed.ok && sealed.val) {
    const opened = decrypt(sealed.val, encryptionKey);
    if (opened.ok) secret = opened.val;
  }
  const oauth = server.oauth;
  const clientAuth = tokenClientAuth(oauth?.tokenAuthMethods ?? [], secret !== '');
  const origin = new URL(server.url).origin;
  return {
    connector: provider,
    tokenEndpoint: oauth?.tokenEndpoint ?? null,
    hosts: [],
    origins: [origin],
    anonymous: server.authMode === 'none',
    clientAuth,
    revocationEndpoint: oauth?.revocationEndpoint ?? undefined,
    staticConfig: {
      connector: provider,
      enabled: true,
      settings: { clientId: server.clientId ?? '' },
      secrets: secret ? { clientSecret: secret } : {},
    },
    adapter: () =>
      oauth ? new GenericOAuthAdapter(provider, oauth.tokenEndpoint, secret, clientAuth) : null,
  };
}

export function providerSpec(provider: string): ProviderSpec | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? PROVIDERS[provider] : null;
}

/**
 * A stand-in for a provider's API, for the e2e and dev environments that
 * point the web app's clients at a local stub (`GITHUB_API_BASE_URL`,
 * `BITBUCKET_API_BASE_URL`, `JIRA_ADMIN_API_BASE_URL`,
 * `JIRA_AUTOMATION_API_BASE_URL`, `ENTRA_DEVELOPER_API_BASE_URL`): the
 * delegate honors the same variables,
 * so a request to that origin may carry the provider's token too. Unset
 * in production, where only the provider's own hosts are allowed.
 */
export const STAND_IN_ENV: Readonly<Record<string, string>> = {
  [GITHUB]: 'GITHUB_API_BASE_URL',
  [ATLASSIAN_BITBUCKET]: 'BITBUCKET_API_BASE_URL',
  [ATLASSIAN_ADMIN]: 'JIRA_ADMIN_API_BASE_URL',
  // The same stand-in: a request type change request applies on the JSM
  // grant, through the Jira Administration client on the same gateway
  // (apps/web/lib/jira-admin/request-type.ts).
  [ATLASSIAN_JSM]: 'JIRA_ADMIN_API_BASE_URL',
  // The Automation API's stand-in (apps/web/lib/mcp-tools/jira-admin/automation-client.ts).
  [ATLASSIAN_ADMIN_TOKEN]: 'JIRA_AUTOMATION_API_BASE_URL',
  [ENTRA_DEVELOPER]: 'ENTRA_DEVELOPER_API_BASE_URL',
};

/**
 * The stand-in variables that are set although NODE_ENV is production. A
 * stand-in lets a provider's token travel to an arbitrary origin over plain
 * HTTP, which is a development convenience and a production hole: the
 * delegate refuses to boot with any of them (index.ts), and `hostAllowed`
 * ignores them regardless.
 */
export function standInViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  return [...new Set(Object.values(STAND_IN_ENV))].filter((name) => Boolean(env[name]?.trim()));
}

/**
 * A stand-in's origin, honoured outside production — and on the in-memory
 * data store, which is never a deployment (nothing is persisted): the
 * memory UI suite runs a production build on it in CI, its delegate in
 * the web app's own process (apps/web/lib/memory-delegate.ts).
 */
function standInOrigin(provider: string): string | null {
  if (process.env.NODE_ENV === 'production' && !memoryDataStoreRequested()) return null;
  const name = Object.prototype.hasOwnProperty.call(STAND_IN_ENV, provider)
    ? STAND_IN_ENV[provider]
    : null;
  const value = name ? process.env[name]?.trim() : '';
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Whether `url` may carry this provider's token: exact host, or a subdomain
 * of a dotted entry. `extraHosts` are the spec's `hostsFor` for this grant
 * or pending exchange — exact matches only.
 */
export function hostAllowed(
  spec: ProviderSpec,
  url: URL,
  provider?: string,
  extraHosts: readonly string[] = []
): boolean {
  if (provider && standInOrigin(provider) === url.origin) return true;
  if (spec.origins?.includes(url.origin)) return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (url.port === '' && extraHosts.some((allowed) => host === allowed.toLowerCase())) return true;
  return spec.hosts.some((allowed) =>
    allowed.startsWith('.') ? host.endsWith(allowed) || host === allowed.slice(1) : host === allowed
  );
}

/** The app registration for a provider, from connector config; null when none is saved. */
export async function providerConfig(
  spec: ProviderSpec,
  encryptionKey: Buffer
): Promise<ConnectorConfig | null> {
  if (spec.staticConfig) return spec.staticConfig;
  const result = await readConnectorConfigCached(spec.connector, encryptionKey);
  return result.ok ? result.val : null;
}

/**
 * Microsoft's token endpoint is per directory, Salesforce's per org;
 * everyone else's is fixed. `which` is the directory tenant id, or the
 * Salesforce org's key.
 */
export function tokenEndpointFor(
  spec: ProviderSpec,
  config: ConnectorConfig | null,
  which?: string
): string | null {
  if (spec.tokenEndpoint) return spec.tokenEndpoint;
  if (spec.tokenEndpointFrom) return spec.tokenEndpointFrom(config, which);
  const directoryTenantId = which;
  if (spec.hosts.some((host) => host === 'graph.microsoft.com')) {
    const tid = directoryTenantId || settingOf(config, 'directoryTenantId');
    return tid
      ? `https://login.microsoftonline.com/${encodeURIComponent(tid)}/oauth2/v2.0/token`
      : null;
  }
  return null;
}

export function clientIdOf(config: ConnectorConfig | null): string {
  return settingOf(config, 'clientId');
}

export function clientSecretOf(config: ConnectorConfig | null): string {
  return secretOf(config);
}

/** The grant row for a person on a provider, or by account id when the caller already knows it. */
export async function grantRow(
  provider: string,
  by: { subject?: string; accountId?: string }
): Promise<{ accountId: string; subject: string | null } | null> {
  const grants = getDataStore().providerGrants;
  let row: { accountId: string; subject: string | null } | null | undefined;
  if (by.accountId) row = await grants.find(provider, by.accountId);
  // A person has one grant per provider in practice; with several, the
  // first by account id answers, so the choice is stable.
  else if (by.subject) row = (await grants.listForSubject(by.subject, { provider }))[0];
  else return null;
  return row ? { accountId: row.accountId, subject: row.subject } : null;
}
