/**
 * Creating a Jira space — the second kind of change request (stage 1c of
 * docs/project-management-design.md): a new company-managed space on the
 * schemes of a template or of an existing space, then the groups and people
 * each role should hold, its components and any versions named for it.
 *
 * The space runs ON those schemes, it does not get copies: that is what
 * keeps a family of spaces in step, and it is also why the review page
 * says so — a later change to one of the schemes changes every space on
 * it. Copying a scheme so one space can differ is a separate, later change.
 *
 * Applying re-checks the one thing likeliest to have moved since the
 * proposal — the key being taken — then creates the space in one call and
 * adds only the role members it does not already have (Jira puts a role's
 * default members in at creation, and refuses to add one twice). As with
 * field options, it stops at the first operation that fails; a space that
 * was created stays created, and the results say which roles were set.
 *
 * Components and versions are manage:jira-project writes, where everything
 * else here is manage:jira-configuration — so a proposal with either needs
 * the connection's "Space components, versions and screens" permission to
 * apply (createSpaceScopes).
 */

import {
  jiraAdminGet,
  jiraAdminSend,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';
import type { OperationResult } from './change-requests';
import type { Group, Person } from './people';
import { SCHEME_KEYS, SCHEME_LABELS, type SchemeRef, type SpaceSchemes } from './space-config';
import {
  readTemplateComponents,
  type TemplateComponent,
  type TemplateDocument,
} from './space-templates';

export const CREATE_SPACE_KIND = 'create_space';

/** Jira Cloud's rule for a key: an uppercase letter, then uppercase letters, digits or _, 2–10 long. */
export const SPACE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,9}$/;

interface LogScope {
  tenantId: string;
  subject?: string;
}

export interface CreateSpaceOperation {
  op: 'create_space';
  key: string;
  name: string;
  description: string | null;
  lead: Person;
  projectTypeKey: string;
  assigneeType: string | null;
  category: { id: string; name: string } | null;
  schemes: SpaceSchemes;
}

export interface RoleMembersOperation {
  op: 'add_role_members';
  roleId: string;
  roleName: string;
  groups: Group[];
  users: Person[];
}

export interface ComponentsOperation {
  op: 'add_components';
  components: TemplateComponent[];
}

export interface VersionPlan {
  name: string;
  /** YYYY-MM-DD, or null. */
  startDate: string | null;
  releaseDate: string | null;
}

export interface VersionsOperation {
  op: 'add_versions';
  versions: VersionPlan[];
}

export type SpaceOperation =
  CreateSpaceOperation | RoleMembersOperation | ComponentsOperation | VersionsOperation;

/** A calendar date as Jira takes it for a version. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateSpacePayload {
  source: { kind: 'template'; id: string; name: string } | { kind: 'space'; key: string };
  /** How many spaces ran on its workflow scheme when proposed; null when Jira would not say. */
  workflowUsage: { count: number; more: boolean } | null;
  operations: SpaceOperation[];
}

/** What a space is built from: a template's document, or a live space read the same way. */
export type SpaceBase = Pick<
  TemplateDocument,
  'projectTypeKey' | 'assigneeType' | 'category' | 'schemes' | 'roles' | 'components'
>;

/** The classic scopes applying this proposal takes (lib/jira-admin/apply.ts asks). */
export function createSpaceScopes(payload: CreateSpacePayload): string[] {
  const scopes = ['read:jira-work', 'manage:jira-configuration'];
  const projectWrites = payload.operations.some(
    (operation) => operation.op === 'add_components' || operation.op === 'add_versions'
  );
  return projectWrites ? [...scopes, 'manage:jira-project'] : scopes;
}

// ---- planning --------------------------------------------------------------

/**
 * The operations for a new space: create it, then fill each role — the
 * base's groups plus whoever the proposal names — skipping roles left
 * empty; then the base's components plus any more the proposal names, and
 * the versions it names.
 */
export function planSpaceCreation(input: {
  key: string;
  name: string;
  description: string | null;
  lead: Person;
  base: SpaceBase;
  members: { roleId: string; roleName: string; groups: Group[]; users: Person[] }[];
  /** Components beyond the base's, by name. */
  components?: string[];
  versions?: VersionPlan[];
}): SpaceOperation[] {
  const roles = new Map<string, RoleMembersOperation>();
  const entry = (roleId: string, roleName: string) => {
    const existing = roles.get(roleId);
    if (existing) return existing;
    const created: RoleMembersOperation = {
      op: 'add_role_members',
      roleId,
      roleName,
      groups: [],
      users: [],
    };
    roles.set(roleId, created);
    return created;
  };
  const addGroup = (target: RoleMembersOperation, group: Group) => {
    const same = (other: Group) =>
      (group.groupId && other.groupId === group.groupId) ||
      other.name.toLowerCase() === group.name.toLowerCase();
    if (!target.groups.some(same)) target.groups.push(group);
  };
  for (const role of input.base.roles) {
    const target = entry(role.roleId, role.roleName);
    for (const group of role.groups) addGroup(target, group);
  }
  for (const member of input.members) {
    const target = entry(member.roleId, member.roleName);
    for (const group of member.groups) addGroup(target, group);
    for (const user of member.users) {
      if (!target.users.some((other) => other.accountId === user.accountId)) {
        target.users.push(user);
      }
    }
  }

  const components: TemplateComponent[] = [];
  const named = new Set<string>();
  for (const component of [
    ...(input.base.components ?? []),
    ...(input.components ?? []).map((name) => ({
      name,
      description: null,
      assigneeType: 'PROJECT_DEFAULT',
    })),
  ]) {
    const name = component.name.trim();
    if (!name || named.has(name.toLowerCase())) continue;
    named.add(name.toLowerCase());
    components.push({ ...component, name });
  }
  const versions: VersionPlan[] = [];
  for (const version of input.versions ?? []) {
    const name = version.name.trim();
    if (!name || versions.some((other) => other.name.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    versions.push({ ...version, name });
  }

  return [
    {
      op: 'create_space',
      key: input.key,
      name: input.name,
      description: input.description,
      lead: input.lead,
      projectTypeKey: input.base.projectTypeKey,
      assigneeType: input.base.assigneeType,
      category: input.base.category,
      schemes: input.base.schemes,
    },
    ...[...roles.values()]
      .filter((role) => role.groups.length + role.users.length > 0)
      .sort((a, b) => a.roleName.localeCompare(b.roleName)),
    ...(components.length > 0 ? [{ op: 'add_components' as const, components }] : []),
    ...(versions.length > 0 ? [{ op: 'add_versions' as const, versions }] : []),
  ];
}

// ---- describing ------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  software: 'software',
  business: 'business',
  service_desk: 'service',
};

const ASSIGNEE_LABELS: Record<string, string> = {
  PROJECT_LEAD: 'the space lead',
  UNASSIGNED: 'unassigned',
};

export function sourceLabel(payload: CreateSpacePayload): string {
  return payload.source.kind === 'template'
    ? `template “${payload.source.name}”`
    : `space ${payload.source.key}`;
}

function scheme(value: SchemeRef | null, none: string): string {
  return value ? `“${value.name}”` : none;
}

export interface DescribedSpaceOperation {
  text: string;
  access: boolean;
  details: string[];
}

export function describeSpaceOperation(
  operation: SpaceOperation,
  payload?: CreateSpacePayload
): DescribedSpaceOperation {
  if (operation.op === 'create_space') {
    const usage = payload?.workflowUsage;
    const shared =
      usage && (usage.count > 0 || usage.more)
        ? ` — shared with ${usage.count}${usage.more ? '+' : ''} space${usage.count === 1 && !usage.more ? '' : 's'}`
        : '';
    return {
      text:
        `Create the ${TYPE_LABELS[operation.projectTypeKey] ?? operation.projectTypeKey} space ` +
        `${operation.key} — “${operation.name}” — led by ${operation.lead.displayName}` +
        (payload ? `, on the schemes of ${sourceLabel(payload)}` : ''),
      // The permission scheme decides who can see the space at all.
      access: true,
      details: [
        ...SCHEME_KEYS.map((key) => {
          const value = operation.schemes[key];
          const none =
            key === 'fieldConfigurationScheme'
              ? 'the system default'
              : key === 'issueSecurityScheme'
                ? 'none'
                : 'unknown';
          const label = SCHEME_LABELS[key];
          return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${scheme(value, none)}${
            key === 'workflowScheme' ? shared : ''
          }`;
        }),
        `Default assignee: ${ASSIGNEE_LABELS[operation.assigneeType ?? ''] ?? 'Jira’s default'}`,
        ...(operation.category ? [`Category: ${operation.category.name}`] : []),
        ...(operation.description ? [`Description: ${operation.description}`] : []),
      ],
    };
  }
  if (operation.op === 'add_components') {
    return {
      text: `Add ${plural(operation.components.length, 'component')}: ${operation.components
        .map((component) => component.name)
        .join(', ')}`,
      access: false,
      details: operation.components.map(
        (component) =>
          `${component.name}${component.description ? ` — ${component.description}` : ''}` +
          (COMPONENT_ASSIGNEE_LABELS[component.assigneeType]
            ? ` (${COMPONENT_ASSIGNEE_LABELS[component.assigneeType]})`
            : '')
      ),
    };
  }
  if (operation.op === 'add_versions') {
    return {
      text: `Add ${plural(operation.versions.length, 'version')}: ${operation.versions
        .map((version) => version.name)
        .join(', ')}`,
      access: false,
      details: operation.versions
        .filter((version) => version.startDate || version.releaseDate)
        .map(
          (version) =>
            `${version.name}: ${[
              version.startDate ? `starts ${version.startDate}` : '',
              version.releaseDate ? `releases ${version.releaseDate}` : '',
            ]
              .filter(Boolean)
              .join(', ')}`
        ),
    };
  }
  const members = [
    ...operation.groups.map((group) => `group “${group.name}”`),
    ...operation.users.map((user) => user.displayName),
  ];
  return {
    text: `Add ${members.join(', ')} to the ${operation.roleName} role`,
    access: true,
    details: [],
  };
}

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** Only the component assignee rules worth a word: the default says nothing. */
const COMPONENT_ASSIGNEE_LABELS: Record<string, string> = {
  PROJECT_LEAD: 'its issues go to the space lead',
  UNASSIGNED: 'its issues start unassigned',
};

export function describeSpaceReach(payload: CreateSpacePayload, siteUrl: string | null): string {
  const create = payload.operations.find(
    (operation): operation is CreateSpaceOperation => operation.op === 'create_space'
  );
  return (
    `A new space${create ? ` ${create.key}` : ''}${siteUrl ? ` on ${siteUrl}` : ''}, running on the ` +
    `same schemes as ${sourceLabel(payload)} rather than copies of them — a later change to ` +
    'one of those schemes changes every space on it.'
  );
}

/** "New space FIN “Finance”, like OPS" — a list row's title. */
export function spaceTitle(payload: CreateSpacePayload): string {
  const create = payload.operations.find(
    (operation): operation is CreateSpaceOperation => operation.op === 'create_space'
  );
  const what = create ? `New space ${create.key} “${create.name}”` : 'New space';
  const from =
    payload.source.kind === 'template'
      ? `from template “${payload.source.name}”`
      : `like ${payload.source.key}`;
  const title = `${what}, ${from}`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading ---------------------------------------------------------------

function schemeRef(value: unknown): SchemeRef | null {
  const record = rec(value);
  return str(record.id) && typeof record.name === 'string'
    ? { id: str(record.id), name: record.name }
    : null;
}

function personOf(value: unknown): Person | null {
  const record = rec(value);
  return str(record.accountId) && typeof record.displayName === 'string'
    ? { accountId: str(record.accountId), displayName: record.displayName }
    : null;
}

function readSchemes(value: unknown): SpaceSchemes | null {
  const record = rec(value);
  const at = (key: keyof SpaceSchemes) => (record[key] === null ? null : schemeRef(record[key]));
  const issueTypeScheme = at('issueTypeScheme');
  const issueTypeScreenScheme = at('issueTypeScreenScheme');
  const workflowScheme = at('workflowScheme');
  const permissionScheme = at('permissionScheme');
  const notificationScheme = at('notificationScheme');
  if (
    !issueTypeScheme ||
    !issueTypeScreenScheme ||
    !workflowScheme ||
    !permissionScheme ||
    !notificationScheme
  ) {
    return null;
  }
  return {
    issueTypeScheme,
    issueTypeScreenScheme,
    workflowScheme,
    fieldConfigurationScheme: at('fieldConfigurationScheme'),
    permissionScheme,
    notificationScheme,
    issueSecurityScheme: at('issueSecurityScheme'),
  };
}

function readOperation(value: unknown): SpaceOperation | null {
  const record = rec(value);
  if (record.op === 'create_space') {
    const lead = personOf(record.lead);
    const schemes = readSchemes(record.schemes);
    const category = rec(record.category);
    if (
      !SPACE_KEY_PATTERN.test(str(record.key)) ||
      typeof record.name !== 'string' ||
      !lead ||
      !schemes ||
      !str(record.projectTypeKey)
    ) {
      return null;
    }
    return {
      op: 'create_space',
      key: str(record.key),
      name: record.name,
      description: str(record.description) || null,
      lead,
      projectTypeKey: str(record.projectTypeKey),
      assigneeType: str(record.assigneeType) || null,
      category: str(category.id) ? { id: str(category.id), name: str(category.name) } : null,
      schemes,
    };
  }
  if (record.op === 'add_role_members') {
    if (!str(record.roleId) || typeof record.roleName !== 'string') return null;
    const groups = records(record.groups)
      .filter((group) => typeof group.name === 'string')
      .map((group) => ({ groupId: str(group.groupId), name: str(group.name) }));
    const users = records(record.users).flatMap((user) => {
      const person = personOf(user);
      return person ? [person] : [];
    });
    return {
      op: 'add_role_members',
      roleId: str(record.roleId),
      roleName: record.roleName,
      groups,
      users,
    };
  }
  if (record.op === 'add_components') {
    const components = readTemplateComponents(record.components);
    return components && components.length > 0 ? { op: 'add_components', components } : null;
  }
  if (record.op === 'add_versions') {
    const date = (value: unknown) => (DATE_PATTERN.test(str(value)) ? str(value) : null);
    const versions = records(record.versions)
      .filter((version) => str(version.name))
      .map((version) => ({
        name: str(version.name),
        startDate: date(version.startDate),
        releaseDate: date(version.releaseDate),
      }));
    return versions.length > 0 ? { op: 'add_versions', versions } : null;
  }
  return null;
}

/** The payload as stored, or null when it is not one this code wrote in full. */
export function readCreateSpacePayload(value: unknown): CreateSpacePayload | null {
  const record = rec(value);
  const source = rec(record.source);
  const parsedSource =
    source.kind === 'template' && str(source.id) && typeof source.name === 'string'
      ? { kind: 'template' as const, id: str(source.id), name: source.name }
      : source.kind === 'space' && str(source.key)
        ? { kind: 'space' as const, key: str(source.key) }
        : null;
  if (!parsedSource || !Array.isArray(record.operations)) return null;
  const operations: SpaceOperation[] = [];
  for (const item of record.operations) {
    const operation = readOperation(item);
    if (!operation) return null;
    operations.push(operation);
  }
  if (operations[0]?.op !== 'create_space') return null;
  const usage = rec(record.workflowUsage);
  return {
    source: parsedSource,
    workflowUsage:
      typeof usage.count === 'number' ? { count: usage.count, more: usage.more === true } : null,
    operations,
  };
}

// ---- applying ----------------------------------------------------------------

function createBody(operation: CreateSpaceOperation): Record<string, unknown> {
  const { schemes } = operation;
  const id = (value: SchemeRef) => Number(value.id);
  return {
    key: operation.key,
    name: operation.name,
    ...(operation.description ? { description: operation.description } : {}),
    leadAccountId: operation.lead.accountId,
    projectTypeKey: operation.projectTypeKey,
    ...(operation.assigneeType ? { assigneeType: operation.assigneeType } : {}),
    ...(operation.category ? { categoryId: Number(operation.category.id) } : {}),
    issueTypeScheme: id(schemes.issueTypeScheme),
    issueTypeScreenScheme: id(schemes.issueTypeScreenScheme),
    workflowScheme: id(schemes.workflowScheme),
    ...(schemes.fieldConfigurationScheme
      ? { fieldConfigurationScheme: id(schemes.fieldConfigurationScheme) }
      : {}),
    permissionScheme: id(schemes.permissionScheme),
    notificationScheme: id(schemes.notificationScheme),
    ...(schemes.issueSecurityScheme
      ? { issueSecurityScheme: id(schemes.issueSecurityScheme) }
      : {}),
  };
}

type Step = { ok: true; note?: string } | { ok: false; error: string };

async function createSpace(
  scope: LogScope,
  access: JiraAdminAccess,
  operation: CreateSpaceOperation
): Promise<Step & { id?: string }> {
  const check = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/projectvalidate/key?key=${encodeURIComponent(operation.key)}`
  );
  if (!check.ok) return { ok: false, error: `Checking the key ${operation.key}: ${check.error}` };
  const taken = str(rec(rec(check.body).errors).projectKey);
  if (taken) return { ok: false, error: `${operation.key} cannot be used now: ${taken}` };

  const created = await jiraAdminSend(
    scope,
    access,
    'POST',
    '/rest/api/3/project',
    createBody(operation)
  );
  if (!created.ok) return { ok: false, error: created.error };
  const key = str(rec(created.body).key) || operation.key;
  return {
    ok: true,
    id: str(rec(created.body).id) || undefined,
    note: access.siteUrl ? `${access.siteUrl}/browse/${key}` : undefined,
  };
}

async function addRoleMembers(
  scope: LogScope,
  access: JiraAdminAccess,
  spaceKey: string,
  operation: RoleMembersOperation
): Promise<Step> {
  const path = `/rest/api/3/project/${encodeURIComponent(spaceKey)}/role/${encodeURIComponent(operation.roleId)}`;
  const current = await jiraAdminGet(scope, access, path);
  if (!current.ok)
    return { ok: false, error: `Reading the ${operation.roleName} role: ${current.error}` };
  const actors = records(rec(current.body).actors);
  const heldGroups = actors
    .map((actor) => rec(actor.actorGroup))
    .filter((g) => Object.keys(g).length);
  const heldUsers = new Set(
    actors.map((actor) => str(rec(actor.actorUser).accountId)).filter(Boolean)
  );
  const groups = operation.groups.filter(
    (group) =>
      !heldGroups.some(
        (held) =>
          (group.groupId && str(held.groupId) === group.groupId) ||
          str(held.name).toLowerCase() === group.name.toLowerCase()
      )
  );
  const users = operation.users.filter((user) => !heldUsers.has(user.accountId));
  const already = operation.groups.length + operation.users.length - groups.length - users.length;
  const note = already > 0 ? `${already} already in the role.` : undefined;
  if (groups.length + users.length === 0) return { ok: true, note };

  // Jira takes a group by id or by name, not both in one call; ids survive
  // a rename, so they go first and names only for groups saved without one.
  const byId = groups.filter((group) => group.groupId);
  const byName = groups.filter((group) => !group.groupId);
  const first = await jiraAdminSend(scope, access, 'POST', path, {
    ...(byId.length > 0 ? { groupId: byId.map((group) => group.groupId) } : {}),
    ...(users.length > 0 ? { user: users.map((user) => user.accountId) } : {}),
  });
  if (!first.ok) return { ok: false, error: first.error };
  if (byName.length > 0) {
    const second = await jiraAdminSend(scope, access, 'POST', path, {
      group: byName.map((group) => group.name),
    });
    if (!second.ok) return { ok: false, error: second.error };
  }
  return { ok: true, note };
}

/**
 * Add the components the space does not have yet, by name. A component Jira
 * refuses stops the rest; the error names any added before it.
 */
async function addComponents(
  scope: LogScope,
  access: JiraAdminAccess,
  spaceKey: string,
  operation: ComponentsOperation
): Promise<Step> {
  const current = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/project/${encodeURIComponent(spaceKey)}/components`
  );
  if (!current.ok) return { ok: false, error: `Reading the components: ${current.error}` };
  const held = new Set(records(current.body).map((component) => str(component.name).toLowerCase()));
  const wanted = operation.components.filter(
    (component) => !held.has(component.name.toLowerCase())
  );
  const added: string[] = [];
  for (const component of wanted) {
    const result = await jiraAdminSend(scope, access, 'POST', '/rest/api/3/component', {
      project: spaceKey,
      name: component.name,
      ...(component.description ? { description: component.description } : {}),
      assigneeType: component.assigneeType,
    });
    if (!result.ok) {
      return { ok: false, error: `“${component.name}”: ${result.error}${addedFirst(added)}` };
    }
    added.push(component.name);
  }
  const already = operation.components.length - wanted.length;
  return { ok: true, note: already > 0 ? `${already} already there.` : undefined };
}

/** The versions the space does not have yet, by name — stopping, like components, at a refusal. */
async function addVersions(
  scope: LogScope,
  access: JiraAdminAccess,
  space: { key: string; id: string | null },
  operation: VersionsOperation
): Promise<Step> {
  let spaceId = space.id;
  if (!spaceId) {
    const project = await jiraAdminGet(
      scope,
      access,
      `/rest/api/3/project/${encodeURIComponent(space.key)}`
    );
    if (!project.ok) return { ok: false, error: `Reading ${space.key}: ${project.error}` };
    spaceId = str(rec(project.body).id);
  }
  const current = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/project/${encodeURIComponent(space.key)}/versions`
  );
  if (!current.ok) return { ok: false, error: `Reading the versions: ${current.error}` };
  const held = new Set(records(current.body).map((version) => str(version.name).toLowerCase()));
  const wanted = operation.versions.filter((version) => !held.has(version.name.toLowerCase()));
  const added: string[] = [];
  for (const version of wanted) {
    const result = await jiraAdminSend(scope, access, 'POST', '/rest/api/3/version', {
      projectId: Number(spaceId),
      name: version.name,
      ...(version.startDate ? { startDate: version.startDate } : {}),
      ...(version.releaseDate ? { releaseDate: version.releaseDate } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: `“${version.name}”: ${result.error}${addedFirst(added)}` };
    }
    added.push(version.name);
  }
  const already = operation.versions.length - wanted.length;
  return { ok: true, note: already > 0 ? `${already} already there.` : undefined };
}

function addedFirst(added: string[]): string {
  return added.length > 0
    ? ` (${added.map((name) => `“${name}”`).join(', ')} ${added.length === 1 ? 'was' : 'were'} added before it.)`
    : '';
}

/**
 * Apply a stored create-space proposal: create the space, then set its
 * roles, components and versions, stopping at the first operation that
 * fails.
 */
export async function applySpaceCreation(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: CreateSpacePayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  let space: { key: string; id: string | null } | null = null;
  let stopped = false;
  for (const operation of payload.operations) {
    const label = describeSpaceOperation(operation).text;
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    let step: Step;
    if (operation.op === 'create_space') {
      const created = await createSpace(scope, access, operation);
      if (created.ok) space = { key: operation.key, id: created.id ?? null };
      step = created;
    } else if (!space) {
      step = { ok: false, error: 'The space was not created, so nothing can be added to it.' };
    } else if (operation.op === 'add_role_members') {
      step = await addRoleMembers(scope, access, space.key, operation);
    } else if (operation.op === 'add_components') {
      step = await addComponents(scope, access, space.key, operation);
    } else {
      step = await addVersions(scope, access, space, operation);
    }
    if (!step.ok) {
      results.push({ label, outcome: 'failed', detail: step.error });
      stopped = true;
      continue;
    }
    results.push({ label, outcome: 'done', ...(step.note ? { detail: step.note } : {}) });
  }
  const done = results.filter((result) => result.outcome === 'done').length;
  return {
    status: done === results.length ? 'applied' : done === 0 ? 'failed' : 'partial',
    results,
  };
}
