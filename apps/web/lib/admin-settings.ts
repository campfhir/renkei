/**
 * Settings, in groups: what the Settings page lists, which page each
 * heading is on, and where each group lives. One list for the console's
 * navigation (app/(app)/admin/admin-nav.model.ts) and the top-bar search
 * (app-places.ts), so the two cannot drift apart.
 */

export const SETTINGS_HREF = '/admin/settings';

/**
 * The headings Settings' one form carries (settings-form.tsx takes its
 * headings from this type), each in the group whose page shows it.
 */
export type SettingsPart =
  | 'Organization'
  | 'AD Manager'
  | 'Safety'
  | 'Agents'
  | 'Notifications'
  | 'Data & logs'
  | 'Knowledge search'
  | 'MCP clients & tokens'
  | 'Request limits'
  | 'Sandbox'
  | 'Code previews';

export type SettingsGroupId = 'general' | 'safety' | 'agents' | 'data' | 'access' | 'sandbox';

/** The icon each group shows: names in components/icons.tsx's ICONS. */
export type SettingsGroupIcon = 'building' | 'shield' | 'agent' | 'archive' | 'lock' | 'package';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  icon: SettingsGroupIcon;
  /** What the group holds, for the Settings page's list. */
  blurb: string;
  /** The form's headings on this group's page, in page order. */
  parts: readonly SettingsPart[];
  /**
   * What the page holds besides the form's parts, each saved on its own:
   * the headings an operator would look for, in page order after the form.
   */
  also: readonly string[];
}

/**
 * Settings, in groups: each its own page under /admin/settings, listed on
 * the Settings page and, on a wide screen, under Settings in the sidebar.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'building',
    blurb: 'The organization’s name, sign-in and roles',
    parts: ['Organization', 'AD Manager'],
    also: ['Identity'],
  },
  {
    id: 'safety',
    label: 'Safety',
    icon: 'shield',
    blurb: 'Read-only mode, guided tours and locked tools',
    parts: ['Safety'],
    also: ['Locked high-risk tools'],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'agent',
    blurb: 'Run limits, and who accepts an agent’s changes',
    parts: ['Agents', 'Notifications'],
    also: [],
  },
  {
    id: 'data',
    label: 'Data & search',
    icon: 'archive',
    blurb: 'Logging, retention and the knowledge index',
    parts: ['Data & logs', 'Knowledge search'],
    also: [],
  },
  {
    id: 'access',
    label: 'Access & limits',
    icon: 'lock',
    blurb: 'Token lifetimes, MCP clients and request limits',
    parts: ['MCP clients & tokens', 'Request limits'],
    also: [],
  },
  {
    id: 'sandbox',
    label: 'Sandbox & code',
    icon: 'package',
    blurb: 'What a sandbox may do, its sizes and code previews',
    parts: ['Sandbox', 'Code previews'],
    also: ['Checkout size requests'],
  },
];

/** A group's page. */
export function settingsGroupHref(id: SettingsGroupId): string {
  return `${SETTINGS_HREF}/${id}`;
}

/** The group with this id, or null: what a `/admin/settings/[group]` path names. */
export function settingsGroup(id: string): SettingsGroup | null {
  return SETTINGS_GROUPS.find((group) => group.id === id) ?? null;
}

/** The group whose page carries a heading, one of the form's or one beside it. */
export function settingsGroupOf(heading: string): SettingsGroup | null {
  return (
    SETTINGS_GROUPS.find(
      (group) => group.parts.some((part) => part === heading) || group.also.includes(heading)
    ) ?? null
  );
}
