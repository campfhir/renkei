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
}

const PREFERENCES = '/preferences';
const CONNECTORS = '/connectors';
const ADMIN_SETTINGS = '/admin/settings';

const SETTINGS: AppPlaceEntry[] = [
  {
    title: 'Dark mode and appearance',
    where: 'Preferences · Appearance',
    href: `${PREFERENCES}#appearance-heading`,
    keywords: 'theme dark light color colour display mode',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Notifications',
    where: 'Preferences',
    href: `${PREFERENCES}#notifications-heading`,
    keywords: 'alerts pop-ups popups desktop runs batch jobs sharing notify',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Voice',
    where: 'Preferences',
    href: `${PREFERENCES}#voice-heading`,
    keywords: 'speech read aloud microphone dictation spoken language',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Image model',
    where: 'Preferences',
    href: `${PREFERENCES}#image-model-heading`,
    keywords: 'images pictures picture generation draw',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Chat archive',
    where: 'Preferences',
    href: `${PREFERENCES}#chat-archive-heading`,
    keywords: 'archive old chats automatically hide',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Tool permissions',
    where: 'Preferences',
    href: `${PREFERENCES}#tool-permissions-heading`,
    keywords: 'approval approve permission permissions tools ask allow confirm',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Default tools for new chats',
    where: 'Preferences',
    href: `${PREFERENCES}#default-tools-heading-chat`,
    keywords: 'default tools new chat enabled',
    section: 'Settings',
    operatorOnly: false,
  },
  {
    title: 'Default tools for code',
    where: 'Preferences',
    href: `${PREFERENCES}#default-tools-heading-code`,
    keywords: 'default tools code repository',
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
    where: 'Preferences',
    href: `${PREFERENCES}#encryption-key`,
    keywords: 'encryption key security device share passphrase',
    section: 'Settings',
    operatorOnly: false,
  },
];

/** The connector cards on the Connectors page, by the id each card carries. */
const CONNECTOR_CARDS: { title: string; card: string; keywords: string }[] = [
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
}));

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
];

const ORGANIZATION_PLACES: AppPlaceEntry[] = [
  ...ORGANIZATION_SETTINGS.map((entry) => ({
    title: entry.title,
    where: 'Organization settings',
    href: `${ADMIN_SETTINGS}#${anchorId('settings', entry.title)}`,
    keywords: entry.keywords,
    section: 'Organization' as const,
    operatorOnly: true,
  })),
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
 * caller passes the needle already lower-cased.
 */
export function matchPlaceEntries(needle: string, isOperator: boolean): AppPlaceEntry[] {
  const terms = needle.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matched = APP_PLACE_ENTRIES.filter((place) => {
    if (place.operatorOnly && !isOperator) return false;
    const haystack = `${place.title} ${place.where} ${place.keywords}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const titled = (place: AppPlaceEntry) => place.title.toLowerCase().includes(needle);
  return [...matched.filter(titled), ...matched.filter((place) => !titled(place))];
}
