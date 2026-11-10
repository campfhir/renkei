/**
 * What the person's Connectors page (page.tsx, server-rendered) decides
 * before it draws: which cards are on the page and in what order, which of
 * them "needs setup" (something added but never connected) and so floats
 * into its own section above the rest, which Atlassian and Hyland products
 * a card hosts, the org's scope ceiling each connect card narrows within,
 * the products a person may take back off, what the Add connector catalog
 * lists, and Zoom's scope drift. Pure; tested in
 * connectors-page.model.test.ts. The page reads the store, calls these, and
 * renders a card per entry.
 */

import { isRecord } from '@renkei/guards';
import {
  ATLASSIAN,
  ATLASSIAN_ADMIN,
  ATLASSIAN_BITBUCKET,
  ATLASSIAN_CONFLUENCE,
  ATLASSIAN_JSM,
  ENTRA_DEVELOPER,
  GITHUB,
  MICROSOFT,
  ONBASE,
  ONBASE_ADMIN,
  WEBEX_USER,
  ZOOM,
} from '@renkei/provider-grants';

// ---------------------------------------------------------------------------
// Scope ceilings

/** The org's stored scopes string for a connector, from its non-secret settings. */
export function storedScopes(settings: unknown): string | null {
  if (!isRecord(settings)) return null;
  const scopes = settings.scopes;
  return typeof scopes === 'string' && scopes ? scopes : null;
}

/** The org's scope ceiling for a connector: its stored scopes, or the catalog's defaults. */
export function ceilingFrom(settings: unknown, fallback: string): string[] {
  return (storedScopes(settings) ?? fallback).split(/\s+/);
}

// ---------------------------------------------------------------------------
// The catalog

/** What the page knows about the person's catalog (lib/connectors/user-catalog.ts). */
export interface PageCatalog<Entry extends { capabilityKey: string }> {
  available: readonly Entry[];
  shown: ReadonlySet<string>;
  connected: ReadonlySet<string>;
  added: readonly string[];
}

/** The Add connector dialog's rows: every entry offered, marked added and connected. */
export function catalogItems<Entry extends { capabilityKey: string }>(
  catalog: PageCatalog<Entry>
): { entry: Entry; added: boolean; connected: boolean }[] {
  return catalog.available.map((entry) => ({
    entry,
    added: catalog.added.includes(entry.capabilityKey),
    connected: catalog.connected.has(entry.capabilityKey),
  }));
}

/**
 * Under a card, the products on the page with nothing connected — the ones
 * a person may take back off. Connected products are not listed: they have
 * Disconnect, and hiding a live connection is not on offer.
 */
export function removableProducts(
  catalog: Pick<PageCatalog<{ capabilityKey: string }>, 'shown' | 'connected'>,
  keys: readonly string[],
  labelOf: (capabilityKey: string) => string
): { capabilityKey: string; label: string }[] {
  return keys
    .filter((key) => catalog.shown.has(key) && !catalog.connected.has(key))
    .map((key) => ({ capabilityKey: key, label: labelOf(key) }));
}

// ---------------------------------------------------------------------------
// What each card hosts

/** The Microsoft 365 card's panels on the page, in the card's order. */
export const MICROSOFT_KEYS = ['microsoft', 'sharepoint', 'onedrive', 'teams', 'onenote'] as const;

export function microsoftShownKeys(shown: ReadonlySet<string>): string[] {
  return MICROSOFT_KEYS.filter((key) => shown.has(key));
}

/**
 * The Atlassian card's products. Jira and JSM share the 'jira' capability
 * key, so each is hosted only where the org registered its app too.
 */
export function atlassianProducts(
  shown: ReadonlySet<string>,
  enabledConfigs: ReadonlySet<string>
): { jira: boolean; jsm: boolean; jiraAdmin: boolean; confluence: boolean; bitbucket: boolean } {
  const jiraShown = shown.has('jira');
  return {
    jira: jiraShown && enabledConfigs.has('atlassian'),
    jsm: jiraShown && enabledConfigs.has('atlassian-jsm'),
    jiraAdmin: shown.has('jira-admin'),
    confluence: shown.has('atlassian-confluence'),
    bitbucket: shown.has('atlassian-bitbucket'),
  };
}

function atlassianCardShown(shown: ReadonlySet<string>): boolean {
  return (
    shown.has('jira') ||
    shown.has('jira-admin') ||
    shown.has('atlassian-confluence') ||
    shown.has('atlassian-bitbucket')
  );
}

function hylandCardShown(shown: ReadonlySet<string>): boolean {
  return shown.has('onbase') || shown.has('onbase-admin');
}

/**
 * Whether the page has any connector card. With none, it shows the
 * "Nothing added yet" prompt in place of the header's Add button. The
 * browser secrets card does not count: nothing is added there.
 */
export function anyConnectorCard(shown: ReadonlySet<string>, mcpServerCount: number): boolean {
  return (
    atlassianCardShown(shown) ||
    shown.has('webex') ||
    microsoftShownKeys(shown).length > 0 ||
    shown.has('entra-developer') ||
    shown.has('zoom') ||
    shown.has('github') ||
    shown.has('salesforce') ||
    shown.has('salesforce-admin') ||
    hylandCardShown(shown) ||
    shown.has('fileshares') ||
    shown.has('mirth') ||
    shown.has('admanager') ||
    mcpServerCount > 0
  );
}

/**
 * Scopes the person asked Zoom for that the minted token does not carry.
 * Zoom silently drops a scope missing from the Marketplace app, and the
 * only other symptom is tools quietly not registering. A grant with no
 * recorded granted scopes claims no drift.
 */
export function zoomMissingScopes(
  grant:
    | { requestedScopes: readonly string[] | null; grantedScopes: readonly string[] | null }
    | undefined
): string[] {
  const granted = grant?.grantedScopes;
  if (!granted) return [];
  return (grant.requestedScopes ?? []).filter((scope) => !granted.includes(scope));
}

/** Whether a WebEx grant reads every space, not only the ones the person picks. */
export function webexAllSpaces(grant: { metadata: unknown } | undefined): boolean {
  return isRecord(grant?.metadata) && grant.metadata.allSpaces === true;
}

// ---------------------------------------------------------------------------
// The cards, their order, and "Needs setup"

/** Everything the card list turns on, as the page read it. */
export interface CardsInput {
  /** Capability keys with a card on the page (added ∪ connected). */
  shown: ReadonlySet<string>;
  /** Providers the person holds a grant on. */
  grants: ReadonlySet<string>;
  /** Connector configs the org switched on. */
  enabledConfigs: ReadonlySet<string>;
  /** Per Salesforce kind on the page: its enabled orgs, and the person's connections (a null org is one since removed). */
  salesforce: readonly {
    kindKey: string;
    orgKeys: readonly string[];
    connectedOrgs: readonly (string | null)[];
  }[];
  /** Per registered share / instance: whether the person connected it. */
  fileshares: readonly { connected: boolean }[];
  mirth: readonly { connected: boolean }[];
  admanager: readonly { connected: boolean }[];
  /** The remote MCP servers offered to this person. */
  mcpServers: readonly { authMode: string; connected: boolean }[];
  /** Whether the deployment runs the sandbox browser (its secrets card). */
  browserSecrets: boolean;
}

export type SingleCardKey =
  | 'atlassian'
  | 'webex'
  | 'microsoft'
  | 'entra-developer'
  | 'zoom'
  | 'github'
  | 'hyland'
  | 'fileshares'
  | 'mirth'
  | 'admanager'
  | 'mcp-servers'
  | 'browser-secrets';

export type ConnectorCard =
  | { kind: 'single'; key: SingleCardKey; needsAttention: boolean }
  | {
      kind: 'salesforce';
      key: string;
      kindKey: string;
      orgKey: string;
      /** The kind's last org card carries the kind's remove link. */
      last: boolean;
      needsAttention: boolean;
    }
  | { kind: 'salesforce-removed'; key: string; kindKey: string; needsAttention: true };

/**
 * The page's cards in their fixed order, each tagged with whether it has
 * something a person added but never finished connecting.
 *
 * A single-grant card needs setup until it is connected. Microsoft is one
 * consent for every panel, so it too is simply "not connected". Atlassian
 * and Hyland need setup while any product they host is unconnected; file
 * shares, Mirth and AD Manager while any registered one is; MCP servers
 * while any OAuth server is (a server with no sign-in has nothing to
 * finish). A connection to a Salesforce org since removed always does.
 * The browser secrets card never does: nothing is added there.
 */
export function connectorCards(input: CardsInput): ConnectorCard[] {
  const { shown, grants } = input;
  const missing = (provider: string) => !grants.has(provider);
  const cards: ConnectorCard[] = [];
  const single = (key: SingleCardKey, needsAttention: boolean) =>
    cards.push({ kind: 'single', key, needsAttention });

  if (atlassianCardShown(shown)) {
    const products = atlassianProducts(shown, input.enabledConfigs);
    single(
      'atlassian',
      (products.jira && missing(ATLASSIAN)) ||
        (products.jsm && missing(ATLASSIAN_JSM)) ||
        (products.jiraAdmin && missing(ATLASSIAN_ADMIN)) ||
        (products.confluence && missing(ATLASSIAN_CONFLUENCE)) ||
        (products.bitbucket && missing(ATLASSIAN_BITBUCKET))
    );
  }
  if (shown.has('webex')) single('webex', missing(WEBEX_USER));
  if (microsoftShownKeys(shown).length > 0) single('microsoft', missing(MICROSOFT));
  if (shown.has('entra-developer')) single('entra-developer', missing(ENTRA_DEVELOPER));
  if (shown.has('zoom')) single('zoom', missing(ZOOM));
  if (shown.has('github')) single('github', missing(GITHUB));

  for (const { kindKey, orgKeys, connectedOrgs } of input.salesforce) {
    orgKeys.forEach((orgKey, index) =>
      cards.push({
        kind: 'salesforce',
        key: `${kindKey}:${orgKey}`,
        kindKey,
        orgKey,
        last: index === orgKeys.length - 1,
        needsAttention: !connectedOrgs.includes(orgKey),
      })
    );
    if (connectedOrgs.includes(null)) {
      cards.push({
        kind: 'salesforce-removed',
        key: `${kindKey}:removed`,
        kindKey,
        needsAttention: true,
      });
    }
  }

  if (hylandCardShown(shown)) {
    single(
      'hyland',
      (shown.has('onbase') && missing(ONBASE)) ||
        (shown.has('onbase-admin') && missing(ONBASE_ADMIN))
    );
  }
  const anyUnconnected = (rows: readonly { connected: boolean }[]) =>
    rows.some((row) => !row.connected);
  if (shown.has('fileshares')) single('fileshares', anyUnconnected(input.fileshares));
  if (shown.has('mirth')) single('mirth', anyUnconnected(input.mirth));
  if (shown.has('admanager')) single('admanager', anyUnconnected(input.admanager));
  if (input.mcpServers.length > 0) {
    single(
      'mcp-servers',
      input.mcpServers.some((server) => server.authMode === 'oauth' && !server.connected)
    );
  }
  if (input.browserSecrets) single('browser-secrets', false);
  return cards;
}

/**
 * The page's two sections, each keeping the cards' order: "Needs setup"
 * first, then the rest. The second section is headed "Connected" only when
 * there is a "Needs setup" above it; with nothing to set up the page does
 * not insist on a heading for a distinction that is not live.
 */
export function pageSections<Card extends { needsAttention: boolean }>(
  cards: readonly Card[]
): { needsSetup: Card[]; settled: Card[]; settledHeading: 'Connected' | null } {
  const needsSetup = cards.filter((card) => card.needsAttention);
  const settled = cards.filter((card) => !card.needsAttention);
  return {
    needsSetup,
    settled,
    settledHeading: needsSetup.length > 0 && settled.length > 0 ? 'Connected' : null,
  };
}
