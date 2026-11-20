/**
 * People in SharePoint list columns.
 *
 * A person column does not hold a person. It holds a number: the person's
 * row in the site's hidden "User Information List", which is per SITE —
 * the same colleague is 14 on one site and 31 on the next, and neither is
 * their directory id. Graph returns a single-person column only as that
 * number (`ProjectManagerLookupId: "14"`), with no name beside it, and
 * writing one takes the number too.
 *
 * Shown bare, the number invited guessing: an agent read "14" off a row
 * and wrote it as the person's own id, filling 26 rows with someone else
 * as Project Manager. So:
 *
 *   - `sharepoint_find_site_user` turns an email, a name or "me" into the
 *     site's number, which is the only correct source for a write;
 *   - the item reads name the person beside each number they show
 *     (`labelPeople`), so a number is never read without its person.
 *
 * A person who has never been added to the site (no visit, no permission
 * granted to them directly) has no row yet. Graph cannot create one —
 * SharePoint's own ensureUser is outside Graph — so the tool says so
 * rather than offering a near match.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuthedFetch } from '@renkei/delegate-client';
import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import type { GraphCallContext } from '../graph/client';
import { withPresentationHint } from '../common';
import { graphGet, values, str, rec, textResult, errText } from '../graph/client';
import { resolveSite } from '../graph/resolve';

/** The hidden list every site keeps its people in; Graph accepts a list's title in its path. */
const USER_LIST = `lists/${encodeURIComponent('User Information List')}`;

/** Its Title/EMail/UserName columns are not indexed. */
const NON_INDEXED = { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' };

/** More distinct people than this on one page are left as numbers, not looked up one by one. */
const MAX_LOOKUPS = 25;

export interface SiteUser {
  lookupId: string;
  name: string;
  email: string;
}

function userOf(item: Record<string, unknown>): SiteUser {
  const fields = rec(item.fields);
  return {
    lookupId: str(item.id),
    name: str(fields.Title),
    email: str(fields.EMail) || str(fields.UserName),
  };
}

const odataString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** "Ada Lovelace <ada@example.com>", or whichever half is known. */
export function personLabel(user: SiteUser): string {
  if (user.name && user.email) return `${user.name} <${user.email}>`;
  return user.name || user.email;
}

/**
 * The site's people matching an email or user name exactly, else whose
 * display name starts with the query. Exact email first: a name prefix can
 * match several people, and a write must not pick one of them silently.
 */
export async function findSiteUsers(
  context: GraphCallContext,
  auth: AuthedFetch,
  siteId: string,
  query: string
): Promise<{ ok: true; users: SiteUser[] } | { ok: false; error: string }> {
  const select = '$expand=fields($select=Title,EMail,UserName)&$top=10';
  const base = `/sites/${siteId}/${USER_LIST}/items?${select}`;
  const filters = query.includes('@')
    ? [`fields/EMail eq ${odataString(query)}`, `fields/UserName eq ${odataString(query)}`]
    : [`startswith(fields/Title,${odataString(query)})`];

  for (const filter of filters) {
    const found = await graphGet(
      context,
      auth,
      `${base}&$filter=${encodeURIComponent(filter)}`,
      NON_INDEXED
    );
    if (!found.ok) return { ok: false, error: found.error };
    const users = values(found.body)
      .map(userOf)
      .filter((user) => user.lookupId);
    if (users.length > 0) return { ok: true, users };
  }
  return { ok: true, users: [] };
}

/** The site's people behind these numbers; a number that cannot be read is left out. */
export async function siteUsersById(
  context: GraphCallContext,
  auth: AuthedFetch,
  siteId: string,
  ids: string[]
): Promise<Map<string, SiteUser>> {
  const wanted = [...new Set(ids.filter((id) => /^\d+$/.test(id)))].slice(0, MAX_LOOKUPS);
  const found = await Promise.all(
    wanted.map((id) =>
      graphGet(
        context,
        auth,
        `/sites/${siteId}/${USER_LIST}/items/${id}?$expand=fields($select=Title,EMail,UserName)`
      )
    )
  );
  const users = new Map<string, SiteUser>();
  found.forEach((result, index) => {
    if (result.ok) users.set(wanted[index], { ...userOf(result.body), lookupId: wanted[index] });
  });
  return users;
}

/** The internal names of a list's person columns (Created By and Modified By among them). */
export async function personColumnsOf(
  context: GraphCallContext,
  auth: AuthedFetch,
  siteId: string,
  listId: string
): Promise<Set<string>> {
  const columns = await graphGet(context, auth, `/sites/${siteId}/lists/${listId}/columns`);
  if (!columns.ok) return new Set();
  return new Set(
    values(columns.body)
      .filter((column) => column.personOrGroup !== undefined)
      .map((column) => str(column.name))
      .filter(Boolean)
  );
}

/** The site numbers a set of items' person columns hold. */
export function personIdsIn(
  itemsFields: Record<string, unknown>[],
  personColumns: Set<string>
): string[] {
  const ids: string[] = [];
  for (const fields of itemsFields) {
    for (const [key, value] of Object.entries(fields)) {
      if (!key.endsWith('LookupId') || !personColumns.has(key.slice(0, -'LookupId'.length))) {
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number') ids.push(String(value));
      if (Array.isArray(value)) ids.push(...value.map(String));
    }
  }
  return ids;
}

/**
 * A field as an answer shows it, with the person named beside a person
 * column's number: `ProjectManagerLookupId: 14 (Bryan Smith <bryan@example.com>)`.
 */
export function labelPeople(
  key: string,
  value: unknown,
  personColumns: Set<string>,
  users: Map<string, SiteUser>
): string {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  if (!key.endsWith('LookupId') || !personColumns.has(key.slice(0, -'LookupId'.length))) {
    return shown;
  }
  const ids = Array.isArray(value) ? value.map(String) : [String(value)];
  const named = ids.map((id) => {
    const user = users.get(id);
    return user ? `${id} (${personLabel(user)})` : id;
  });
  return named.join(', ');
}

export function registerSiteUserTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): void {
  server.registerTool(
    'sharepoint_find_site_user',
    {
      title: 'SharePoint · Read — Find a person’s id on a site',
      description:
        'The number a SharePoint site knows a person by, which a person column needs: write it ' +
        'as {Column}LookupId (e.g. {"ProjectManagerLookupId": "18"}) with ' +
        'sharepoint_create_list_item or sharepoint_update_list_item. The number is per site and is ' +
        'not a directory id — never take one from another site or from someone else’s row. Pass ' +
        '"me" for the signed-in person.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        site: z.string().min(1).describe('Site URL or id (a list URL works too).'),
        person: z
          .string()
          .min(1)
          .describe('An email address, the start of a display name, or "me".'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const asked = str(args.person).trim();
      const isMe = asked.toLowerCase() === 'me';
      const query = isMe ? (access.upn ?? '') : asked;
      if (!query) {
        return errText(
          'The Microsoft connection did not record your account address, so "me" cannot be ' +
            'looked up; give your email address instead.'
        );
      }

      const site = await resolveSite(context, access.auth, str(args.site));
      if (!site.ok) return errText(site.error);

      const found = await findSiteUsers(context, access.auth, site.siteId, query);
      if (!found.ok) return errText(found.error);

      if (found.users.length === 0) {
        return errText(
          `${isMe ? `You (${query}) are` : `"${query}" is`} not yet in ${site.name}'s people, ` +
            'so a person column on it cannot be set to them. SharePoint adds a person when ' +
            'they first open the site or are given access to it; until then, set the column in ' +
            'SharePoint itself. Do not use another number in its place.'
        );
      }
      const lines = found.users.map(
        (user) => `${personLabel(user)}\n    lookupId: ${user.lookupId}`
      );
      return textResult(
        withPresentationHint(
          (found.users.length > 1
            ? `${found.users.length} people on ${site.name} match "${query}" — ask which one ` +
              'before writing any of them.\n\n'
            : `On ${site.name}:\n\n`) + lines.join('\n'),
          'Render as a short list of people.'
        )
      );
    }
  );
}
