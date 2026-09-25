/**
 * Turning what a person actually says — "the Payroll app", an appId pasted
 * from the portal, "jane@contoso.com", "Finance Readers" — into the
 * directory objects the Graph calls need. Every tool takes the same
 * references, resolved here: an object id, an application (client) id, or
 * a display name, with an exact-name match required and an ambiguous name
 * refused with what exists rather than guessed at.
 */

import {
  entraGet,
  entraPages,
  isGuid,
  odataString,
  rec,
  recs,
  searchClause,
  str,
  strings,
  values,
  EVENTUAL,
  type EntraAccess,
  type EntraCallContext,
} from './client';

export const APPLICATION_SELECT =
  '$select=id,appId,displayName,description,signInAudience,createdDateTime,identifierUris,' +
  'web,spa,publicClient,appRoles,tags,notes';

export const SERVICE_PRINCIPAL_SELECT =
  '$select=id,appId,displayName,accountEnabled,servicePrincipalType,appOwnerOrganizationId,' +
  'appRoleAssignmentRequired,appRoles,tags,loginUrl,replyUrls,homepage';

/** The app role Entra assigns when an application defines no roles at all. */
export const DEFAULT_APP_ROLE_ID = '00000000-0000-0000-0000-000000000000';

export interface AppRole {
  id: string;
  displayName: string;
  description: string;
  value: string;
  isEnabled: boolean;
  allowedMemberTypes: string[];
}

export function appRolesOf(object: Record<string, unknown>): AppRole[] {
  return recs(object.appRoles).map((role) => ({
    id: str(role.id),
    displayName: str(role.displayName),
    description: str(role.description),
    value: str(role.value),
    isEnabled: role.isEnabled !== false,
    allowedMemberTypes: strings(role.allowedMemberTypes),
  }));
}

/** One line for a role in a listing. */
export function describeRole(role: AppRole): string {
  const members = role.allowedMemberTypes.length > 0 ? role.allowedMemberTypes.join('/') : 'User';
  return (
    `${role.displayName || '(unnamed)'}` +
    (role.value ? ` [${role.value}]` : ' [no value]') +
    ` — ${role.description || 'no description'} (${members}${role.isEnabled ? '' : ', disabled'}; id ${role.id})`
  );
}

type Found<T> = { ok: true; value: T } | { ok: false; error: string };

function exactNameFilter(field: string, name: string): string {
  return `${field} eq ${odataString(name)}`;
}

/**
 * An app registration by object id, application (client) id, or exact
 * display name. Names are matched exactly, case-insensitively by Graph; two
 * registrations with one name is a refusal that names their ids.
 */
export async function findApplication(
  context: EntraCallContext,
  access: EntraAccess,
  reference: string
): Promise<Found<Record<string, unknown>>> {
  const ref = reference.trim();
  if (!ref) return { ok: false, error: 'An application reference is required.' };
  if (isGuid(ref)) {
    const byId = await entraGet(context, access, `/applications/${ref}?${APPLICATION_SELECT}`);
    if (byId.ok) return { ok: true, value: byId.body };
    if (byId.status !== 404) return { ok: false, error: byId.error };
    const byAppId = await entraGet(
      context,
      access,
      `/applications(appId=${odataString(ref)})?${APPLICATION_SELECT}`
    );
    if (byAppId.ok) return { ok: true, value: byAppId.body };
    return {
      ok: false,
      error:
        byAppId.status === 404
          ? `No app registration has object id or application (client) id ${ref}.`
          : byAppId.error,
    };
  }
  const listed = await entraGet(
    context,
    access,
    `/applications?$filter=${encodeURIComponent(exactNameFilter('displayName', ref))}&$top=5&${APPLICATION_SELECT}`
  );
  if (!listed.ok) return { ok: false, error: listed.error };
  return pickOne(values(listed.body), ref, 'app registration', 'entra_list_applications');
}

/**
 * An enterprise application (service principal) by object id, application
 * (client) id, or exact display name.
 */
export async function findServicePrincipal(
  context: EntraCallContext,
  access: EntraAccess,
  reference: string
): Promise<Found<Record<string, unknown>>> {
  const ref = reference.trim();
  if (!ref) return { ok: false, error: 'An enterprise application reference is required.' };
  if (isGuid(ref)) {
    const byId = await entraGet(
      context,
      access,
      `/servicePrincipals/${ref}?${SERVICE_PRINCIPAL_SELECT}`
    );
    if (byId.ok) return { ok: true, value: byId.body };
    if (byId.status !== 404) return { ok: false, error: byId.error };
    const byAppId = await servicePrincipalForAppId(context, access, ref);
    if (!byAppId.ok) return byAppId;
    if (byAppId.value) return { ok: true, value: byAppId.value };
    return {
      ok: false,
      error:
        `No enterprise application has object id or application (client) id ${ref}. If that ` +
        'is an app registration, it may have no enterprise application yet — ' +
        'entra_create_enterprise_application_preview creates one.',
    };
  }
  const listed = await entraGet(
    context,
    access,
    `/servicePrincipals?$filter=${encodeURIComponent(exactNameFilter('displayName', ref))}&$top=5&${SERVICE_PRINCIPAL_SELECT}`
  );
  if (!listed.ok) return { ok: false, error: listed.error };
  return pickOne(
    values(listed.body),
    ref,
    'enterprise application',
    'entra_list_enterprise_applications'
  );
}

/** The service principal for an application (client) id, or null when none exists yet. */
export async function servicePrincipalForAppId(
  context: EntraCallContext,
  access: EntraAccess,
  appId: string
): Promise<Found<Record<string, unknown> | null>> {
  const listed = await entraGet(
    context,
    access,
    `/servicePrincipals?$filter=${encodeURIComponent(`appId eq ${odataString(appId)}`)}&$top=1&${SERVICE_PRINCIPAL_SELECT}`
  );
  if (!listed.ok) return { ok: false, error: listed.error };
  return { ok: true, value: values(listed.body)[0] ?? null };
}

function pickOne(
  matches: Record<string, unknown>[],
  name: string,
  kind: string,
  listTool: string
): Found<Record<string, unknown>> {
  if (matches.length === 1) return { ok: true, value: matches[0] };
  if (matches.length === 0) {
    return {
      ok: false,
      error: `No ${kind} is named exactly "${name}". ${listTool} searches by partial name.`,
    };
  }
  return {
    ok: false,
    error:
      `${matches.length} ${kind}s are named "${name}"; pass one by id instead: ` +
      matches.map((m) => `${str(m.id)} (appId ${str(m.appId)})`).join(', '),
  };
}

/**
 * An app role on an application or enterprise application, by id, value
 * or display name (case-insensitive). With no reference and no roles
 * defined, the default role every assignment on such an app carries.
 */
export function findAppRole(roles: AppRole[], reference: string | undefined): Found<AppRole> {
  const ref = (reference ?? '').trim();
  if (!ref) {
    if (roles.length === 0) {
      return {
        ok: true,
        value: {
          id: DEFAULT_APP_ROLE_ID,
          displayName: 'Default Access',
          description: 'The default role of an application that defines no app roles.',
          value: '',
          isEnabled: true,
          allowedMemberTypes: ['User'],
        },
      };
    }
    return {
      ok: false,
      error:
        'This application defines app roles, so say which one: ' +
        roles.map((role) => role.value || role.displayName).join(', '),
    };
  }
  if (ref.toLowerCase() === DEFAULT_APP_ROLE_ID) {
    return findAppRole(roles, undefined);
  }
  const lower = ref.toLowerCase();
  const byId = roles.filter((role) => role.id.toLowerCase() === lower);
  const byValue = roles.filter((role) => role.value.toLowerCase() === lower);
  const byName = roles.filter((role) => role.displayName.toLowerCase() === lower);
  const matches = byId.length > 0 ? byId : byValue.length > 0 ? byValue : byName;
  if (matches.length === 1) return { ok: true, value: matches[0] };
  if (matches.length === 0) {
    return {
      ok: false,
      error:
        roles.length === 0
          ? `This application defines no app roles, so "${ref}" cannot be one; omit the role to use its default access, or add roles with entra_add_app_roles_preview.`
          : `No app role has id, value or name "${ref}". The roles are: ${roles.map(describeRole).join('; ')}`,
    };
  }
  return {
    ok: false,
    error: `${matches.length} app roles match "${ref}"; pass the role id: ${matches.map((r) => `${r.id} (${r.displayName})`).join(', ')}`,
  };
}

export interface Principal {
  id: string;
  type: 'User' | 'Group';
  displayName: string;
  /** A user's address, a group's mail (may be empty). */
  detail: string;
}

function userPrincipal(user: Record<string, unknown>): Principal {
  return {
    id: str(user.id),
    type: 'User',
    displayName: str(user.displayName),
    detail: str(user.mail) || str(user.userPrincipalName),
  };
}

function groupPrincipal(group: Record<string, unknown>): Principal {
  const kinds = [
    group.securityEnabled === true ? 'security' : '',
    strings(group.groupTypes).includes('Unified') ? 'Microsoft 365' : '',
  ].filter(Boolean);
  return {
    id: str(group.id),
    type: 'Group',
    displayName: str(group.displayName),
    detail: [str(group.mail), kinds.length > 0 ? `${kinds.join(', ')} group` : 'group']
      .filter(Boolean)
      .join(' · '),
  };
}

export const USER_SELECT = '$select=id,displayName,mail,userPrincipalName,jobTitle,department';
export const GROUP_SELECT = '$select=id,displayName,mail,securityEnabled,groupTypes,description';

/**
 * A user or group to assign: an object id (looked up as a user, then as a
 * group), an address (user principal name or mail), or an exact display
 * name across users and groups — one match required.
 */
export async function findPrincipal(
  context: EntraCallContext,
  access: EntraAccess,
  reference: string,
  kind: 'user' | 'group' | 'any' = 'any'
): Promise<Found<Principal>> {
  const ref = reference.trim();
  if (!ref) return { ok: false, error: 'A user or group reference is required.' };

  if (isGuid(ref)) {
    if (kind !== 'group') {
      const user = await entraGet(context, access, `/users/${ref}?${USER_SELECT}`);
      if (user.ok) return { ok: true, value: userPrincipal(user.body) };
      if (user.status !== 404) return { ok: false, error: user.error };
    }
    if (kind !== 'user') {
      const group = await entraGet(context, access, `/groups/${ref}?${GROUP_SELECT}`);
      if (group.ok) return { ok: true, value: groupPrincipal(group.body) };
      if (group.status !== 404) return { ok: false, error: group.error };
    }
    return { ok: false, error: `No user or group has object id ${ref}.` };
  }

  const candidates: Principal[] = [];
  if (kind !== 'group') {
    const filter = ref.includes('@')
      ? `userPrincipalName eq ${odataString(ref)} or mail eq ${odataString(ref)}`
      : exactNameFilter('displayName', ref);
    const users = await entraGet(
      context,
      access,
      `/users?$filter=${encodeURIComponent(filter)}&$top=5&${USER_SELECT}`
    );
    if (!users.ok) return { ok: false, error: users.error };
    candidates.push(...values(users.body).map(userPrincipal));
  }
  if (kind !== 'user') {
    const filter = ref.includes('@')
      ? `mail eq ${odataString(ref)}`
      : exactNameFilter('displayName', ref);
    const groups = await entraGet(
      context,
      access,
      `/groups?$filter=${encodeURIComponent(filter)}&$top=5&${GROUP_SELECT}`
    );
    if (!groups.ok) return { ok: false, error: groups.error };
    candidates.push(...values(groups.body).map(groupPrincipal));
  }
  if (candidates.length === 1) return { ok: true, value: candidates[0] };
  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        `No ${kind === 'any' ? 'user or group' : kind} matches "${ref}" exactly. ` +
        'entra_search_users and entra_search_groups search by partial name.',
    };
  }
  return {
    ok: false,
    error:
      `${candidates.length} users or groups match "${ref}"; pass one by object id: ` +
      candidates
        .map((c) => `${c.id} (${c.type} ${c.displayName}${c.detail ? `, ${c.detail}` : ''})`)
        .join(', '),
  };
}

/** Partial-name search over users, via Graph `$search`. */
export async function searchUsers(
  context: EntraCallContext,
  access: EntraAccess,
  query: string,
  max: number
): Promise<Found<Record<string, unknown>[]>> {
  const term = query.replace(/"/g, '').trim();
  if (!term) return { ok: true, value: [] };
  const search = encodeURIComponent(
    [
      searchClause('displayName', term),
      searchClause('mail', term),
      searchClause('userPrincipalName', term),
    ].join(' OR ')
  );
  const result = await entraGet(
    context,
    access,
    `/users?$search=${search}&$count=true&$top=${max}&${USER_SELECT}`,
    EVENTUAL
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: values(result.body) };
}

/** Partial-name search over groups, via Graph `$search`. */
export async function searchGroups(
  context: EntraCallContext,
  access: EntraAccess,
  query: string,
  max: number
): Promise<Found<Record<string, unknown>[]>> {
  const term = query.replace(/"/g, '').trim();
  if (!term) return { ok: true, value: [] };
  const search = encodeURIComponent(
    [searchClause('displayName', term), searchClause('mail', term)].join(' OR ')
  );
  const result = await entraGet(
    context,
    access,
    `/groups?$search=${search}&$count=true&$top=${max}&${GROUP_SELECT}`,
    EVENTUAL
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: values(result.body) };
}

export interface Assignment {
  id: string;
  appRoleId: string;
  principalId: string;
  principalDisplayName: string;
  principalType: string;
  createdDateTime: string;
}

/** Every user, group and service principal assigned to an enterprise application's roles. */
export async function listAssignments(
  context: EntraCallContext,
  access: EntraAccess,
  servicePrincipalId: string
): Promise<Found<{ assignments: Assignment[]; truncated: boolean }>> {
  const paged = await entraPages(
    context,
    access,
    `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo?$top=100`
  );
  if (!paged.ok) return { ok: false, error: paged.error };
  return {
    ok: true,
    value: {
      assignments: paged.values.map((row) => ({
        id: str(row.id),
        appRoleId: str(row.appRoleId),
        principalId: str(row.principalId),
        principalDisplayName: str(row.principalDisplayName),
        principalType: str(row.principalType),
        createdDateTime: str(row.createdDateTime),
      })),
      truncated: paged.truncated,
    },
  };
}

/** Which role an assignment names, for a listing — the default role reads as such. */
export function roleLabel(roles: AppRole[], appRoleId: string): string {
  if (appRoleId === DEFAULT_APP_ROLE_ID) return 'Default Access';
  const role = roles.find((r) => r.id === appRoleId);
  return role ? role.displayName || role.value || role.id : `role ${appRoleId}`;
}

export { rec };
