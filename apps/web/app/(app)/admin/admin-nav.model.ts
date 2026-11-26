/**
 * The Organization console's navigation, with no React: which area a path
 * is in, whether a path is the area list itself, and the groups Settings
 * is split into, each its own page. admin-nav.tsx renders from this — the
 * sidebar beside the area on a wide screen, the list as the page on a
 * phone — and the areas themselves are lib/admin-areas.ts's, the same
 * list the Organization page and the top-bar search read. Tested in
 * admin-nav.model.test.ts.
 */

import { adminSections, type AdminArea } from '@/lib/admin-areas';
import { SETTINGS_HREF, settingsGroup, type SettingsGroupId } from '@/lib/admin-settings';

export const ADMIN_PATH = '/admin';

const AREAS: readonly AdminArea[] = adminSections().flatMap((section) => section.areas);

function isAt(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The area a path is in: the area's own page, anything under it (an
 * agent's runs under Agent oversight), or a page the area leads to (an MCP
 * server under Connector setup). Null for the area list and for any path
 * that is no area's.
 */
export function currentArea(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '');
  const area = AREAS.find((candidate) =>
    [candidate.href, ...(candidate.under ?? [])].some((root) => isAt(path, root))
  );
  return area?.href ?? null;
}

/** Whether the path is the area list itself (`/admin`). */
export function isAreaList(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === ADMIN_PATH;
}

export {
  SETTINGS_GROUPS,
  SETTINGS_HREF,
  settingsGroup,
  settingsGroupHref,
  settingsGroupOf,
} from '@/lib/admin-settings';
export type {
  SettingsGroup,
  SettingsGroupIcon,
  SettingsGroupId,
  SettingsPart,
} from '@/lib/admin-settings';

/** The Settings group a path is in, or null for the group list and anywhere else. */
export function currentSettingsGroup(pathname: string): SettingsGroupId | null {
  const path = pathname.replace(/\/+$/, '');
  if (!path.startsWith(`${SETTINGS_HREF}/`)) return null;
  return settingsGroup(path.slice(SETTINGS_HREF.length + 1).split('/')[0])?.id ?? null;
}

/**
 * Where a phone's link back leads: a Settings group goes back to
 * Settings, any other page to the area list, and the list itself nowhere.
 */
export function backLink(pathname: string): { href: string; label: string } | null {
  if (isAreaList(pathname)) return null;
  if (currentSettingsGroup(pathname)) return { href: SETTINGS_HREF, label: 'Settings' };
  return { href: ADMIN_PATH, label: 'Organization' };
}
