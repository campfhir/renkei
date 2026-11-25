/**
 * The Organization console's navigation, with no React: which area a path
 * is in, whether a path is the area list itself, and the parts of Settings
 * the sidebar lists under it. admin-nav.tsx renders from this — the
 * sidebar beside the area on a wide screen, the list as the page on a
 * phone — and the areas themselves are lib/admin-areas.ts's, the same
 * list the Organization page and the top-bar search read. Tested in
 * admin-nav.model.test.ts.
 */

import { adminSections, type AdminArea } from '@/lib/admin-areas';

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

/**
 * The parts of the Settings page, in page order, for the sidebar's
 * sub-list while Settings is open. settings-form.tsx takes its headings
 * from this type, so a part cannot be on the page and missing here.
 */
export const SETTINGS_PARTS = [
  'Organization',
  'Safety',
  'Agents',
  'Notifications',
  'Data & logs',
  'Knowledge search',
  'MCP clients & tokens',
  'Request limits',
  'Sandbox',
  'AD Manager',
  'Code previews',
] as const;

export type SettingsPart = (typeof SETTINGS_PARTS)[number];

export const SETTINGS_HREF = `${ADMIN_PATH}/settings`;
