/**
 * Searching the Microsoft 365 directory — the one implementation.
 *
 * Extracted from `outlook_search_users` when a second caller appeared (the
 * trigger-filter people picker, which needs the same people as structured
 * data rather than as prose for a model). Two copies would have been two
 * copies of three things that are easy to get subtly wrong:
 *
 *  - the `$search` expression's quoting, which Graph rejects outright if
 *    the caller's own quotes are not stripped first;
 *  - `ConsistencyLevel: eventual`, without which `$search` answers 400 in a
 *    way that reads exactly like a permissions failure;
 *  - the `$select`, which decides whether a result has an address at all.
 */

import { graphGet, str, values, type GraphCallContext } from './client';

/** `$search` against the directory requires the eventual-consistency header. */
export const DIRECTORY_SEARCH_HEADERS = { ConsistencyLevel: 'eventual' };

export const DIRECTORY_USER_SELECT =
  '$select=id,displayName,jobTitle,department,officeLocation,mail,userPrincipalName,' +
  'businessPhones,mobilePhone';

/**
 * Raw Graph user objects for a name-or-email fragment. Returns the error
 * sentence as a string, matching the convention the rest of the Graph
 * helpers use, so a caller decides the status code.
 */
export async function searchDirectoryUsers(
  context: GraphCallContext,
  accessToken: string,
  query: string,
  max: number
): Promise<Record<string, unknown>[] | string> {
  // Graph parses the search expression, so a quote the user typed would
  // terminate ours and produce a syntax error rather than a search.
  const cleaned = query.replace(/"/g, '').trim();
  if (!cleaned) return [];
  const search = encodeURIComponent(`"displayName:${cleaned}" OR "mail:${cleaned}"`);
  const result = await graphGet(
    context,
    accessToken,
    `/users?$search=${search}&$count=true&$top=${max}&${DIRECTORY_USER_SELECT}`,
    DIRECTORY_SEARCH_HEADERS
  );
  if (!result.ok) return result.error;
  return values(result.body);
}

/** The address a filter should store for a directory entry, or ''. */
export function addressOf(user: Record<string, unknown>): string {
  return str(user.mail) || str(user.userPrincipalName);
}
