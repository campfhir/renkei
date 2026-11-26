/**
 * Where things are in the app, down to the setting or connector itself: the
 * top-bar search looks here before it offers a page (lib/app-index.ts adds
 * the icons it draws them with), and the chat's renkei_link tool hands the
 * same places back as links (lib/chat/platform-tools/navigation.ts). No
 * icons here, so a server module can read the list without the icon set. Each place links to the
 * element that holds it (a `#id` the page renders), so "dark mode" lands on
 * the appearance section and "sharepoint" on the Microsoft 365 card. The
 * organization's own settings are listed for operators only.
 *
 * Keywords are the words a person might type instead of the visible name.
 * A place matches when every word typed appears in its title, where it
 * lives, or its keywords.
 */

import { adminSections } from '@/lib/admin-areas';
import { settingsGroupHref, settingsGroupOf } from '@/lib/admin-settings';
import { anchorId } from '@/lib/hash-scroll';

export interface AppPlaceEntry {
  title: string;
  /** Where it lives, shown under the title. */
  where: string;
  /** A path, with a `#id` naming the element to bring into view. */
  href: string;
  keywords: string;
  section: 'Settings' | 'Connectors' | 'Organization';
  /** Only the organization's operators are offered these. */
  operatorOnly: boolean;
  /**
   * The connector (capability key) this place belongs to, when it has a
   * page of its own once connected: for someone connected, the place leads
   * to `connectedHref` instead of the card on the Connectors page.
   */
  connector?: string;
  connectedHref?: string;
  connectedWhere?: string;
}

const PREFERENCES = '/preferences';
const CONNECTORS = '/connectors';
const ADMIN_SETTINGS = '/admin/settings';

const SETTINGS: AppPlaceEntry[] = [
  {
    title: 'Dark mode and appearance',
    where: 'Preferences · Appearance',
    href: `${PREFERENCES}/appearance`,
    keywords: 'theme dark light color colour display mode',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Notifications',
    where: 'Preferences · Notifications',
    href: `${PREFERENCES}/notifications`,
    keywords: 'alerts pop-ups popups desktop runs batch jobs sharing notify',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Voice',
    where: 'Preferences · Voice',
    href: `${PREFERENCES}/voice`,
    keywords: 'speech read aloud microphone dictation spoken language',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Image model',
    where: 'Preferences · Models',
    href: `${PREFERENCES}/models#image-model-heading`,
    keywords: 'images pictures picture generation draw',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Chat archive',
    where: 'Preferences · Chats',
    href: `${PREFERENCES}/chats#chat-archive-heading`,
    keywords: 'archive old chats automatically hide',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Tool permissions',
    where: 'Preferences · Tool permissions',
    href: `${PREFERENCES}/permissions`,
    keywords: 'approval approve permission permissions tools ask allow confirm',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Default tools for new chats',
    where: 'Preferences · Chats',
    href: `${PREFERENCES}/chats#default-tools-heading-chat`,
    keywords: 'default tools new chat enabled',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Default tools for code',
    where: 'Preferences · Code projects',
    href: `${PREFERENCES}/code#default-tools-heading-code`,
    keywords: 'default tools code repository',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'High-risk tools for agents',
    where: 'Preferences · Agents',
    href: `${PREFERENCES}/agents`,
    keywords: 'high risk risky approval auto accept agents wait locked',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Auto mode: what still asks',
    where: 'Preferences · Code projects',
    href: `${PREFERENCES}/code#high-risk-heading-code`,
    keywords: 'auto mode high risk code project approval ask',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Your data: export and import',
    where: 'Preferences · Your data',
    href: `${PREFERENCES}/data#export-heading`,
    keywords:
      'export download zip backup takeout import chatgpt claude gemini memories profile markdown move migrate',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Encryption key',
    where: 'Preferences · Security',
    href: `${PREFERENCES}/security`,
    keywords: 'encryption key security device share passphrase',
    section: 'Settings',
    operatorOnly: false,
  },
];

/**
 * The connector cards on the Connectors page, by the id each card carries;
 * `page` is where a connector with a page of its own leads once connected.
 */
const CONNECTOR_CARDS: {
  title: string;
  card: string;
  keywords: string;
  page?: { href: string; where: string };
}[] = [
  {
    title: 'Atlassian',
    card: 'atlassian',
    keywords: 'jira confluence bitbucket jsm service desk issues tickets wiki',
  },
  {
    title: 'Microsoft 365',
    card: 'microsoft',
    keywords:
      'sharepoint onedrive outlook teams onenote notebook chat channels calendar mail excel word office files sites',
  },
  { title: 'Webex', card: 'webex', keywords: 'webex meetings cisco' },
  { title: 'Zoom', card: 'zoom', keywords: 'zoom meetings recordings' },
  { title: 'GitHub', card: 'github', keywords: 'github repositories repos pull requests code' },
  { title: 'OnBase', card: 'hyland', keywords: 'onbase hyland documents content records' },
  {
    title: 'Entra developer',
    card: 'entra-developer',
    keywords: 'entra azure ad app registration developer',
  },
  {
    title: 'Microsoft Fabric',
    card: 'fabric',
    keywords: 'fabric power bi lakehouse warehouse notebook pipeline data factory onelake',
    page: { href: '/fabric', where: 'Fabric · workspaces, notebooks and pipelines' },
  },
  {
    title: 'File shares',
    card: 'fileshares',
    keywords: 'file share smb network drive server files',
  },
  { title: 'Mirth Connect', card: 'mirth', keywords: 'mirth hl7 interface engine' },
  { title: 'AD Manager', card: 'admanager', keywords: 'active directory ad groups users' },
  {
    title: 'MCP servers',
    card: 'mcp-servers',
    keywords: 'mcp model context protocol tools server',
  },
  {
    title: 'Sandbox secrets',
    card: 'browser-secrets',
    keywords: 'secrets credentials sandbox browser passwords',
  },
];

const CONNECTOR_PLACES: AppPlaceEntry[] = CONNECTOR_CARDS.map((entry) => ({
  title: entry.title,
  where: 'Connectors',
  href: `${CONNECTORS}#connector-${entry.card}`,
  keywords: `${entry.keywords} connect add configure`,
  section: 'Connectors',
  operatorOnly: false,
  ...(entry.page
    ? { connector: entry.card, connectedHref: entry.page.href, connectedWhere: entry.page.where }
    : {}),
}));

/** The page of Settings a heading is on: its group's, or Settings itself. */
function settingsPageOf(heading: string): string {
  const group = settingsGroupOf(heading);
  return group ? settingsGroupHref(group.id) : ADMIN_SETTINGS;
}

/** The organization's settings sections, by the heading each one carries. */
const ORGANIZATION_SETTINGS: { title: string; keywords: string }[] = [
  { title: 'Organization', keywords: 'name organization display name branding' },
  { title: 'Identity', keywords: 'identity sso login oidc claims roles operators' },
  { title: 'Safety', keywords: 'safety guardrails block filter policy' },
  { title: 'Agents', keywords: 'agents automation runs limits' },
  { title: 'Notifications', keywords: 'notifications alerts email' },
  { title: 'Data & logs', keywords: 'data logs retention audit activity privacy' },
  { title: 'Knowledge search', keywords: 'knowledge search index embeddings' },
  { title: 'MCP clients & tokens', keywords: 'mcp clients tokens api keys' },
  { title: 'Request limits', keywords: 'limits quotas size requests' },
  { title: 'Sandbox', keywords: 'sandbox code workspace services' },
  { title: 'AD Manager', keywords: 'ad manager active directory' },
  { title: 'Code previews', keywords: 'code previews preview host subdomain' },
];

const ORGANIZATION_PLACES: AppPlaceEntry[] = [
  ...ORGANIZATION_SETTINGS.map((entry) => ({
    title: entry.title,
    where: 'Organization settings',
    href: `${settingsPageOf(entry.title)}#${anchorId('settings', entry.title)}`,
    keywords: entry.keywords,
    section: 'Organization' as const,
    operatorOnly: true,
  })),
  {
    title: 'Locked high-risk tools',
    where: 'Organization settings',
    href: `${settingsPageOf('Locked high-risk tools')}#locked-high-risk-tools`,
    keywords: 'high risk locked tools approval agents auto mode always ask',
    section: 'Organization' as const,
    operatorOnly: true,
  },
  // The console's areas, from the same list the Organization page shows.
  ...adminSections().flatMap((section) =>
    section.areas.map((area) => ({
      title: area.label,
      where: `Organization · ${section.label}`,
      href: area.href,
      keywords: area.detail,
      section: 'Organization' as const,
      operatorOnly: true,
    }))
  ),
];

export const APP_PLACE_ENTRIES: AppPlaceEntry[] = [
  ...SETTINGS,
  ...CONNECTOR_PLACES,
  ...ORGANIZATION_PLACES,
];

/**
 * The places every word of `needle` appears in, title matches first. The
 * caller passes the needle already lower-cased; `connected` names the
 * connectors (capability keys) this person has connected, so a connector
 * with a page of its own leads there rather than to its card.
 */
export function matchPlaceEntries(
  needle: string,
  isOperator: boolean,
  connected: ReadonlySet<string> = new Set()
): AppPlaceEntry[] {
  const terms = needle.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matched = APP_PLACE_ENTRIES.filter((place) => {
    if (place.operatorOnly && !isOperator) return false;
    const haystack = `${place.title} ${place.where} ${place.keywords}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const titled = (place: AppPlaceEntry) => place.title.toLowerCase().includes(needle);
  return [...matched.filter(titled), ...matched.filter((place) => !titled(place))].map((place) =>
    place.connector && place.connectedHref && connected.has(place.connector)
      ? { ...place, href: place.connectedHref, where: place.connectedWhere ?? place.where }
      : place
  );
}
