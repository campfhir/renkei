/**
 * The screens a company-managed space shows its work types on, and which
 * other spaces show the same screens — for putting a field on a space
 * (lib/jira-admin/space-field.ts).
 *
 * A space reaches its screens through two schemes: its work type screen
 * scheme maps each work type (or "default") to a screen scheme, and a
 * screen scheme names a screen for creating, editing and viewing an issue
 * (falling back to its default screen). Screens are shared freely — one
 * screen can sit in several screen schemes, each used by several spaces —
 * and adding a field to a screen puts it in front of every space that uses
 * it. So the other spaces are found from the screen up, not from the
 * space's own schemes down.
 *
 * Reading screens and their tabs takes manage:jira-project; the scheme
 * lookups take manage:jira-configuration.
 */

import {
  jiraAdminGet,
  jiraAdminPages,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';

interface LogScope {
  tenantId: string;
  subject?: string;
}

export type ScreenUse = 'create' | 'edit' | 'view';

export interface ScreenTab {
  id: string;
  name: string;
}

export interface SpaceScreen {
  id: string;
  name: string;
  /** What the space shows it for, for the work types asked about. */
  uses: ScreenUse[];
  /** In the screen's order; the first is where a field goes by default. */
  tabs: ScreenTab[];
}

const USES: ScreenUse[] = ['create', 'edit', 'view'];

/**
 * The screens this space uses for these work types (issue type ids), each
 * with its tabs — or why they could not all be read. Like reading a space,
 * it is the whole picture or nothing: a screen left out is a screen the
 * field would silently not be on.
 */
export async function readSpaceScreens(
  scope: LogScope,
  access: JiraAdminAccess,
  input: { spaceId: string; issueTypeIds: string[] }
): Promise<{ ok: true; screens: SpaceScreen[] } | { ok: false; reason: string }> {
  const association = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/issuetypescreenscheme/project?projectId=${encodeURIComponent(input.spaceId)}`
  );
  if (!association.ok) return { ok: false, reason: `Its screens scheme: ${association.error}` };
  const schemeId = str(rec(records(association.body)[0]?.issueTypeScreenScheme).id);
  if (!schemeId) return { ok: false, reason: 'Jira did not say which screens scheme it uses.' };

  const mapping = await jiraAdminPages(
    scope,
    access,
    `/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${encodeURIComponent(schemeId)}`
  );
  if (!mapping.ok) return { ok: false, reason: `Its screens scheme: ${mapping.error}` };
  const screenSchemeFor = (issueTypeId: string) =>
    str(mapping.values.find((item) => str(item.issueTypeId) === issueTypeId)?.screenSchemeId) ||
    str(mapping.values.find((item) => str(item.issueTypeId) === 'default')?.screenSchemeId);
  const screenSchemeIds = [...new Set(input.issueTypeIds.map(screenSchemeFor).filter(Boolean))];
  if (screenSchemeIds.length === 0) {
    return { ok: false, reason: 'Its screens scheme maps none of those work types to screens.' };
  }

  const schemes = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/screenscheme?maxResults=100&${screenSchemeIds
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join('&')}`
  );
  if (!schemes.ok) return { ok: false, reason: `Its screen schemes: ${schemes.error}` };
  const uses = new Map<string, Set<ScreenUse>>();
  for (const scheme of records(schemes.body)) {
    const screens = rec(scheme.screens);
    for (const use of USES) {
      const screenId = str(screens[use]) || str(screens.default);
      if (!screenId) continue;
      const set = uses.get(screenId) ?? new Set<ScreenUse>();
      set.add(use);
      uses.set(screenId, set);
    }
  }
  const screenIds = [...uses.keys()];
  if (screenIds.length === 0) return { ok: false, reason: 'Its screen schemes name no screens.' };

  const named = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/screens?maxResults=100&${screenIds.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`
  );
  if (!named.ok) return { ok: false, reason: `Its screens: ${named.error}` };
  const names = new Map(records(named.body).map((screen) => [str(screen.id), str(screen.name)]));

  const tabs = await Promise.all(
    screenIds.map((id) =>
      jiraAdminGet(scope, access, `/rest/api/3/screens/${encodeURIComponent(id)}/tabs`)
    )
  );
  const screens: SpaceScreen[] = [];
  for (const [index, id] of screenIds.entries()) {
    const listing = tabs[index];
    if (!listing?.ok) {
      return {
        ok: false,
        reason: `The tabs of screen ${names.get(id) || id}: ${listing?.error ?? 'could not be read'}`,
      };
    }
    screens.push({
      id,
      name: names.get(id) || `Screen ${id}`,
      uses: USES.filter((use) => uses.get(id)?.has(use)),
      tabs: records(listing.body)
        .map((tab) => ({ id: str(tab.id), name: str(tab.name) }))
        .filter((tab) => tab.id),
    });
  }
  // Creating first, then editing, then viewing — the order people meet them.
  const rank = (screen: SpaceScreen) => USES.indexOf(screen.uses[0] ?? 'view');
  return { ok: true, screens: screens.sort((a, b) => rank(a) - rank(b)) };
}

/** The most work type screen schemes looked up for their spaces. */
const MAX_SCHEME_LOOKUPS = 25;

export interface ScreenSharing {
  /** Keys of the other spaces that show this screen. */
  spaces: string[];
  /** True when there may be more than `spaces` names. */
  more: boolean;
}

/**
 * For each screen, the OTHER spaces that show it: every screen scheme
 * naming the screen, the work type screen schemes using those, and the
 * spaces on them. Null when Jira would not say — which a caller treats as
 * possibly shared, never as private.
 */
export async function otherSpacesOnScreens(
  scope: LogScope,
  access: JiraAdminAccess,
  screenIds: string[],
  spaceId: string
): Promise<Map<string, ScreenSharing> | null> {
  const schemes = await jiraAdminPages(
    scope,
    access,
    '/rest/api/3/screenscheme?expand=issueTypeScreenSchemes'
  );
  if (!schemes.ok) return null;
  const itssByScreen = new Map<string, Set<string>>(screenIds.map((id) => [id, new Set()]));
  for (const scheme of schemes.values) {
    const screens = Object.values(rec(scheme.screens)).map(str);
    const users = records(scheme.issueTypeScreenSchemes).map((itss) => str(itss.id));
    for (const screenId of screenIds) {
      if (!screens.includes(screenId)) continue;
      for (const id of users) if (id) itssByScreen.get(screenId)?.add(id);
    }
  }

  const itssIds = [...new Set([...itssByScreen.values()].flatMap((set) => [...set]))];
  const looked = itssIds.slice(0, MAX_SCHEME_LOOKUPS);
  const listings = await Promise.all(
    looked.map((id) =>
      jiraAdminGet(
        scope,
        access,
        `/rest/api/3/issuetypescreenscheme/${encodeURIComponent(id)}/project?maxResults=50`
      )
    )
  );
  const spacesOf = new Map<string, { keys: string[]; more: boolean }>();
  for (const [index, id] of looked.entries()) {
    const listing = listings[index];
    if (!listing?.ok) return null;
    spacesOf.set(id, {
      keys: records(listing.body)
        .filter((project) => str(project.id) !== spaceId)
        .map((project) => str(project.key) || `id ${str(project.id)}`),
      more: rec(listing.body).isLast === false,
    });
  }

  const sharing = new Map<string, ScreenSharing>();
  for (const screenId of screenIds) {
    const keys = new Set<string>();
    let more = schemes.truncated || itssIds.length > looked.length;
    for (const id of itssByScreen.get(screenId) ?? []) {
      const found = spacesOf.get(id);
      if (!found) continue;
      for (const key of found.keys) keys.add(key);
      more ||= found.more;
    }
    sharing.set(screenId, { spaces: [...keys].sort(), more });
  }
  return sharing;
}
