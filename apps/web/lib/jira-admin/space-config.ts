/**
 * One Jira space's configuration as data: the facts a new space copies
 * (type, default assignee, category), the seven schemes it runs on, and
 * which groups and people hold each role.
 *
 * Three callers: saving a space as a template, proposing a space "like
 * X", and comparing a space against a template. All three need the whole
 * picture or nothing — a template that silently lost its permission scheme
 * would stamp out spaces on the default one, which is an access change
 * nobody reviewed — so any scheme that cannot be read fails the read. Two
 * absences are answers rather than failures: no field configuration scheme
 * (the space uses the system default) and no issue security scheme.
 *
 * Company-managed spaces only. A team-managed space keeps its work types,
 * fields and workflow inside itself; there is nothing on the site to copy,
 * and this says so.
 */

import {
  jiraAdminGet,
  rec,
  records,
  str,
  type JiraAdminAccess,
  type JiraAdminResult,
} from '@/lib/mcp-tools/jira-admin/client';

interface LogScope {
  tenantId: string;
  subject?: string;
}

export interface SchemeRef {
  id: string;
  name: string;
}

/** The schemes a company-managed space runs on; null where the space has none. */
export interface SpaceSchemes {
  issueTypeScheme: SchemeRef;
  issueTypeScreenScheme: SchemeRef;
  workflowScheme: SchemeRef;
  /** Null: the system default field configuration. */
  fieldConfigurationScheme: SchemeRef | null;
  permissionScheme: SchemeRef;
  notificationScheme: SchemeRef;
  /** Null: no issue security. */
  issueSecurityScheme: SchemeRef | null;
}

export const SCHEME_LABELS: Record<keyof SpaceSchemes, string> = {
  issueTypeScheme: 'work types',
  issueTypeScreenScheme: 'screens',
  workflowScheme: 'workflows',
  fieldConfigurationScheme: 'field configuration',
  permissionScheme: 'permissions',
  notificationScheme: 'notifications',
  issueSecurityScheme: 'issue security',
};

export const SCHEME_KEYS: (keyof SpaceSchemes)[] = [
  'issueTypeScheme',
  'issueTypeScreenScheme',
  'workflowScheme',
  'fieldConfigurationScheme',
  'permissionScheme',
  'notificationScheme',
  'issueSecurityScheme',
];

export interface RoleActors {
  roleId: string;
  roleName: string;
  groups: { groupId: string; name: string }[];
  users: { accountId: string; displayName: string }[];
}

export interface SpaceConfiguration {
  id: string;
  key: string;
  name: string;
  /** 'software' | 'business' | 'service_desk' | … */
  projectTypeKey: string;
  /** 'PROJECT_LEAD' | 'UNASSIGNED', when Jira says. */
  assigneeType: string | null;
  category: { id: string; name: string } | null;
  lead: { accountId: string; displayName: string } | null;
  schemes: SpaceSchemes;
  roles: RoleActors[];
}

export type SpaceRead = { ok: true; space: SpaceConfiguration } | { ok: false; reason: string };

/** The project types a space can be created as from a copy of its schemes. */
export const COPYABLE_TYPES = new Set(['software', 'business']);

function ref(value: unknown): SchemeRef | null {
  const record = rec(value);
  const id = str(record.id);
  return id ? { id, name: str(record.name) || `id ${id}` } : null;
}

/** The scheme a per-project association lookup names for this space. */
function associated(result: JiraAdminResult, key: string): SchemeRef | null {
  if (!result.ok) return null;
  const first = records(result.body)[0];
  return first ? ref(first[key]) : null;
}

/** Every role on the space, with its group and user actors. */
async function readRoles(
  scope: LogScope,
  access: JiraAdminAccess,
  spaceKey: string
): Promise<{ ok: true; roles: RoleActors[] } | { ok: false; reason: string }> {
  const listing = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/project/${encodeURIComponent(spaceKey)}/role`
  );
  if (!listing.ok) return { ok: false, reason: `Roles: ${listing.error}` };
  // { "Administrators": "https://…/role/10002", … } — the id is the URL's tail.
  const entries = Object.entries(rec(listing.body))
    .map(([name, url]) => ({ name, id: /\/role\/(\d+)$/.exec(str(url))?.[1] ?? '' }))
    .filter((role) => role.id);

  const details = await Promise.all(
    entries.map((role) =>
      jiraAdminGet(
        scope,
        access,
        `/rest/api/3/project/${encodeURIComponent(spaceKey)}/role/${role.id}`
      )
    )
  );
  const roles: RoleActors[] = [];
  for (const [index, role] of entries.entries()) {
    const detail = details[index];
    if (!detail?.ok) {
      return { ok: false, reason: `Role ${role.name}: ${detail?.error ?? 'could not be read'}` };
    }
    const groups: RoleActors['groups'] = [];
    const users: RoleActors['users'] = [];
    for (const actor of records(rec(detail.body).actors)) {
      const group = rec(actor.actorGroup);
      if (Object.keys(group).length > 0) {
        groups.push({
          groupId: str(group.groupId),
          name: str(group.name) || str(group.displayName),
        });
        continue;
      }
      const accountId = str(rec(actor.actorUser).accountId);
      if (accountId) users.push({ accountId, displayName: str(actor.displayName) || accountId });
    }
    roles.push({ roleId: role.id, roleName: role.name, groups, users });
  }
  roles.sort((a, b) => a.roleName.localeCompare(b.roleName));
  return { ok: true, roles };
}

/**
 * Read a company-managed space in full, or say why not. `reference` is a
 * space key or numeric id.
 */
export async function readSpaceConfiguration(
  scope: LogScope,
  access: JiraAdminAccess,
  reference: string
): Promise<SpaceRead> {
  const projectResult = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/project/${encodeURIComponent(reference)}?expand=lead`
  );
  if (!projectResult.ok) return { ok: false, reason: `Space ${reference}: ${projectResult.error}` };
  const project = rec(projectResult.body);
  const id = str(project.id);
  const key = str(project.key) || reference;
  if (project.simplified === true || project.style === 'next-gen') {
    return {
      ok: false,
      reason:
        `${key} is team-managed: its work types, fields and workflow live inside the space, ` +
        'so there are no site schemes to copy or compare.',
    };
  }

  const byProject = `projectId=${encodeURIComponent(id)}`;
  const [workTypes, screens, workflows, fields, permissions, notifications, security, roles] =
    await Promise.all([
      jiraAdminGet(scope, access, `/rest/api/3/issuetypescheme/project?${byProject}`),
      jiraAdminGet(scope, access, `/rest/api/3/issuetypescreenscheme/project?${byProject}`),
      jiraAdminGet(scope, access, `/rest/api/3/workflowscheme/project?${byProject}`),
      jiraAdminGet(scope, access, `/rest/api/3/fieldconfigurationscheme/project?${byProject}`),
      jiraAdminGet(
        scope,
        access,
        `/rest/api/3/project/${encodeURIComponent(key)}/permissionscheme`
      ),
      jiraAdminGet(
        scope,
        access,
        `/rest/api/3/project/${encodeURIComponent(key)}/notificationscheme`
      ),
      jiraAdminGet(
        scope,
        access,
        `/rest/api/3/project/${encodeURIComponent(key)}/issuesecuritylevelscheme`
      ),
      readRoles(scope, access, key),
    ]);

  const need = (name: keyof SpaceSchemes, result: JiraAdminResult, value: SchemeRef | null) => {
    if (!result.ok) return `The ${SCHEME_LABELS[name]} scheme: ${result.error}`;
    return value ? null : `The ${SCHEME_LABELS[name]} scheme of ${key} is unknown.`;
  };
  const issueTypeScheme = associated(workTypes, 'issueTypeScheme');
  const issueTypeScreenScheme = associated(screens, 'issueTypeScreenScheme');
  const workflowScheme = associated(workflows, 'workflowScheme');
  const permissionScheme = permissions.ok ? ref(permissions.body) : null;
  const notificationScheme = notifications.ok ? ref(notifications.body) : null;
  const missing =
    need('issueTypeScheme', workTypes, issueTypeScheme) ??
    need('issueTypeScreenScheme', screens, issueTypeScreenScheme) ??
    need('workflowScheme', workflows, workflowScheme) ??
    need('permissionScheme', permissions, permissionScheme) ??
    need('notificationScheme', notifications, notificationScheme);
  if (missing) return { ok: false, reason: missing };
  if (
    !issueTypeScheme ||
    !issueTypeScreenScheme ||
    !workflowScheme ||
    !permissionScheme ||
    !notificationScheme
  ) {
    return { ok: false, reason: `The schemes of ${key} could not all be read.` };
  }
  // A space on the system default field configuration has no scheme row.
  if (!fields.ok) return { ok: false, reason: `The field configuration scheme: ${fields.error}` };
  // No issue security scheme answers 404 — an answer, not a failure.
  if (!security.ok && security.status !== 404) {
    return { ok: false, reason: `The issue security scheme: ${security.error}` };
  }
  if (!roles.ok) return { ok: false, reason: roles.reason };

  const lead = rec(project.lead);
  const category = rec(project.projectCategory);
  return {
    ok: true,
    space: {
      id,
      key,
      name: str(project.name),
      projectTypeKey: str(project.projectTypeKey),
      assigneeType: str(project.assigneeType) || null,
      category: str(category.id) ? { id: str(category.id), name: str(category.name) } : null,
      lead: str(lead.accountId)
        ? { accountId: str(lead.accountId), displayName: str(lead.displayName) }
        : null,
      schemes: {
        issueTypeScheme,
        issueTypeScreenScheme,
        workflowScheme,
        fieldConfigurationScheme: associated(fields, 'fieldConfigurationScheme'),
        permissionScheme,
        notificationScheme,
        issueSecurityScheme: security.ok ? ref(security.body) : null,
      },
      roles: roles.roles,
    },
  };
}

/**
 * How many spaces use this workflow scheme — the count a proposal shows so
 * nobody mistakes a shared scheme for the new space's own. Null when Jira
 * would not say.
 */
export async function workflowSchemeUsage(
  scope: LogScope,
  access: JiraAdminAccess,
  schemeId: string
): Promise<{ count: number; more: boolean } | null> {
  const result = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/workflowscheme/${encodeURIComponent(schemeId)}/projectUsages?maxResults=50`
  );
  if (!result.ok) return null;
  const projects = rec(rec(result.body).projects);
  return {
    count: Array.isArray(projects.values) ? projects.values.length : 0,
    more: Boolean(str(projects.nextPageToken)),
  };
}

/**
 * Do the schemes a template names still exist? A template can outlive a
 * scheme an admin deleted, and it is better to say so at proposal time
 * than as Jira's refusal on apply. Issue security is not checked: reading a
 * security scheme by id takes manage:jira-project, which this stage does
 * not ask for, and applying names the problem if there is one.
 */
export async function missingSchemes(
  scope: LogScope,
  access: JiraAdminAccess,
  schemes: SpaceSchemes
): Promise<string[]> {
  const checks: [keyof SpaceSchemes, string, (body: unknown) => boolean][] = [
    [
      'issueTypeScheme',
      `/rest/api/3/issuetypescheme?id=${encodeURIComponent(schemes.issueTypeScheme.id)}`,
      (body) => records(body).length > 0,
    ],
    [
      'issueTypeScreenScheme',
      `/rest/api/3/issuetypescreenscheme?id=${encodeURIComponent(schemes.issueTypeScreenScheme.id)}`,
      (body) => records(body).length > 0,
    ],
    [
      'workflowScheme',
      `/rest/api/3/workflowscheme/${encodeURIComponent(schemes.workflowScheme.id)}`,
      (body) => Boolean(str(rec(body).id)),
    ],
    [
      'permissionScheme',
      `/rest/api/3/permissionscheme/${encodeURIComponent(schemes.permissionScheme.id)}`,
      (body) => Boolean(str(rec(body).id)),
    ],
    [
      'notificationScheme',
      `/rest/api/3/notificationscheme/${encodeURIComponent(schemes.notificationScheme.id)}`,
      (body) => Boolean(str(rec(body).id)),
    ],
  ];
  if (schemes.fieldConfigurationScheme) {
    checks.push([
      'fieldConfigurationScheme',
      `/rest/api/3/fieldconfigurationscheme?id=${encodeURIComponent(schemes.fieldConfigurationScheme.id)}`,
      (body) => records(body).length > 0,
    ]);
  }
  const results = await Promise.all(
    checks.map(async ([key, path, exists]) => {
      const result = await jiraAdminGet(scope, access, path);
      const scheme = schemes[key];
      return result.ok && exists(result.body)
        ? null
        : `the ${SCHEME_LABELS[key]} scheme “${scheme?.name ?? ''}” (id ${scheme?.id ?? '?'})` +
            (result.ok ? ' no longer exists' : `: ${result.error}`);
    })
  );
  return results.filter((problem): problem is string => problem !== null);
}
