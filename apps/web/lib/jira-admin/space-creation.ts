/**
 * Creating a Jira space — the second kind of change request (stage 1c of
 * docs/project-management-design.md): a new company-managed space on the
 * schemes of a template or of an existing space, then the groups and people
 * each role should hold.
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
import type { TemplateDocument } from './space-templates';

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

export type SpaceOperation = CreateSpaceOperation | RoleMembersOperation;

export interface CreateSpacePayload {
  source: { kind: 'template'; id: string; name: string } | { kind: 'space'; key: string };
  /** How many spaces ran on its workflow scheme when proposed; null when Jira would not say. */
  workflowUsage: { count: number; more: boolean } | null;
  operations: SpaceOperation[];
}

/** What a space is built from: a template's document, or a live space read the same way. */
export type SpaceBase = Pick<
  TemplateDocument,
  'projectTypeKey' | 'assigneeType' | 'category' | 'schemes' | 'roles'
>;

// ---- planning --------------------------------------------------------------

/**
 * The operations for a new space: create it, then fill each role — the
 * base's groups plus whoever the proposal names — skipping roles left
 * empty.
 */
export function planSpaceCreation(input: {
  key: string;
  name: string;
  description: string | null;
  lead: Person;
  base: SpaceBase;
  members: { roleId: string; roleName: string; groups: Group[]; users: Person[] }[];
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
): Promise<Step> {
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
 * Apply a stored create-space proposal: create the space, then set its
 * roles, stopping at the first operation that fails.
 */
export async function applySpaceCreation(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: CreateSpacePayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  let spaceKey: string | null = null;
  let stopped = false;
  for (const operation of payload.operations) {
    const label = describeSpaceOperation(operation).text;
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    let step: Step;
    if (operation.op === 'create_space') {
      step = await createSpace(scope, access, operation);
      if (step.ok) spaceKey = operation.key;
    } else if (!spaceKey) {
      step = { ok: false, error: 'The space was not created, so its roles cannot be set.' };
    } else {
      step = await addRoleMembers(scope, access, spaceKey, operation);
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
