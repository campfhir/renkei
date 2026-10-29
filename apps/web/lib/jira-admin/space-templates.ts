/**
 * Jira space templates (migration 124): a space's configuration captured
 * as a document, for stamping out new spaces the same way
 * (`jira_admin_propose_space`) and for checking an existing space against
 * (`jira_admin_compare_space_to_template`).
 *
 * Org-wide rather than per person — the organization's Jira admins share
 * them — and per site: a template names schemes by id, and ids mean nothing
 * on another Jira site, so every caller checks `cloudId` against the grant
 * it is about to use.
 *
 * The document keeps the GROUPS in each role and never the people: a
 * template describes a kind of space, and who works in the next one is
 * named when it is created. Components are kept the same way — by name,
 * description and who their issues go to, without a lead.
 */

import { getDataStore, type JiraSpaceTemplateRecord } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { rec, records, str } from '@/lib/mcp-tools/jira-admin/client';
import {
  SCHEME_KEYS,
  SCHEME_LABELS,
  type SchemeRef,
  type SpaceConfiguration,
  type SpaceSchemes,
} from './space-config';

export const TEMPLATE_NAME_MAX = 120;

export interface TemplateRole {
  roleId: string;
  roleName: string;
  groups: { groupId: string; name: string }[];
}

export interface TemplateComponent {
  name: string;
  description: string | null;
  /**
   * Who a new issue with the component goes to: 'PROJECT_DEFAULT',
   * 'PROJECT_LEAD' or 'UNASSIGNED' — never 'COMPONENT_LEAD', since a
   * template holds no people to lead one.
   */
  assigneeType: string;
}

export interface TemplateDocument {
  version: 1;
  projectTypeKey: string;
  assigneeType: string | null;
  category: { id: string; name: string } | null;
  schemes: SpaceSchemes;
  roles: TemplateRole[];
  /** Null in a template saved before Renkei kept components. */
  components: TemplateComponent[] | null;
}

/** A component as a template keeps it: a component lead's issues fall to the space's default. */
export function templateComponent(component: {
  name: string;
  description: string | null;
  assigneeType: string;
}): TemplateComponent {
  return {
    name: component.name,
    description: component.description,
    assigneeType:
      component.assigneeType === 'COMPONENT_LEAD' ? 'PROJECT_DEFAULT' : component.assigneeType,
  };
}

export interface SpaceTemplate {
  id: string;
  cloudId: string;
  siteUrl: string | null;
  name: string;
  description: string | null;
  sourceSpaceKey: string | null;
  document: TemplateDocument;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What a template keeps of a space: everything but the people. */
export function documentFromSpace(space: SpaceConfiguration): TemplateDocument {
  return {
    version: 1,
    projectTypeKey: space.projectTypeKey,
    assigneeType: space.assigneeType,
    category: space.category,
    schemes: space.schemes,
    roles: space.roles.map((role) => ({
      roleId: role.roleId,
      roleName: role.roleName,
      groups: role.groups,
    })),
    components: space.components.map(templateComponent),
  };
}

/** A template's components in a phrase — or that it predates keeping them. */
export function componentsText(document: Pick<TemplateDocument, 'components'>): string {
  if (document.components === null) return 'not kept (saved before Renkei kept components)';
  if (document.components.length === 0) return 'none';
  return document.components.map((component) => component.name).join(', ');
}

const COMPONENT_ASSIGNEES = new Set(['PROJECT_DEFAULT', 'PROJECT_LEAD', 'UNASSIGNED']);

/** Stored components, or null when the document predates them. */
export function readTemplateComponents(value: unknown): TemplateComponent[] | null {
  if (!Array.isArray(value)) return null;
  return records(value)
    .filter((component) => str(component.name))
    .map((component) => ({
      name: str(component.name),
      description: str(component.description) || null,
      assigneeType: COMPONENT_ASSIGNEES.has(str(component.assigneeType))
        ? str(component.assigneeType)
        : 'PROJECT_DEFAULT',
    }));
}

function schemeRef(value: unknown): SchemeRef | null {
  const record = rec(value);
  return str(record.id) && typeof record.name === 'string'
    ? { id: str(record.id), name: record.name }
    : null;
}

/** The document as stored, or null when it is not one this code wrote. */
export function readTemplateDocument(value: unknown): TemplateDocument | null {
  const record = rec(value);
  if (record.version !== 1 || !str(record.projectTypeKey)) return null;
  const stored = rec(record.schemes);
  const schemes: Partial<Record<keyof SpaceSchemes, SchemeRef | null>> = {};
  for (const key of SCHEME_KEYS) {
    const scheme = stored[key] === null ? null : schemeRef(stored[key]);
    if (!scheme && key !== 'fieldConfigurationScheme' && key !== 'issueSecurityScheme') {
      return null;
    }
    schemes[key] = scheme;
  }
  const {
    issueTypeScheme,
    issueTypeScreenScheme,
    workflowScheme,
    permissionScheme,
    notificationScheme,
  } = schemes;
  if (
    !issueTypeScheme ||
    !issueTypeScreenScheme ||
    !workflowScheme ||
    !permissionScheme ||
    !notificationScheme
  ) {
    return null;
  }
  const category = rec(record.category);
  return {
    version: 1,
    projectTypeKey: str(record.projectTypeKey),
    assigneeType: str(record.assigneeType) || null,
    category: str(category.id) ? { id: str(category.id), name: str(category.name) } : null,
    schemes: {
      issueTypeScheme,
      issueTypeScreenScheme,
      workflowScheme,
      fieldConfigurationScheme: schemes.fieldConfigurationScheme ?? null,
      permissionScheme,
      notificationScheme,
      issueSecurityScheme: schemes.issueSecurityScheme ?? null,
    },
    roles: records(record.roles)
      .filter((role) => str(role.roleId) && typeof role.roleName === 'string')
      .map((role) => ({
        roleId: str(role.roleId),
        roleName: str(role.roleName),
        groups: records(role.groups)
          .filter((group) => typeof group.name === 'string')
          .map((group) => ({ groupId: str(group.groupId), name: str(group.name) })),
      })),
    components: readTemplateComponents(record.components),
  };
}

export function nameKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

const templates = () => getDataStore().jiraSpaceTemplates;

/** A stored row, or null when its document is unreadable (and so unusable). */
function fromRecord(row: JiraSpaceTemplateRecord): SpaceTemplate | null {
  const document = readTemplateDocument(row.document);
  if (!document) return null;
  return {
    id: row.id,
    cloudId: row.cloudId,
    siteUrl: row.siteUrl,
    name: row.name,
    description: row.description,
    sourceSpaceKey: row.sourceSpaceKey,
    document,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type SaveResult =
  | { ok: true; template: SpaceTemplate; replaced: boolean }
  | { ok: false; reason: 'exists' | 'unreadable' };

/**
 * Save a template under its name. Without `overwrite`, a name already taken
 * on the site is refused rather than replaced; with it, the old document is
 * replaced whole.
 */
export async function saveSpaceTemplate(input: {
  cloudId: string;
  siteUrl?: string;
  name: string;
  description?: string;
  sourceSpaceKey?: string;
  document: TemplateDocument;
  subject: string;
  overwrite: boolean;
}): Promise<SaveResult> {
  const name = input.name.trim().slice(0, TEMPLATE_NAME_MAX);
  // Without overwrite a taken name is left alone — the store answers null,
  // even when two saves race.
  const row = await templates().save(
    {
      cloudId: input.cloudId,
      siteUrl: input.siteUrl || null,
      name,
      nameKey: nameKeyOf(name),
      description: input.description?.trim() ? input.description.trim() : null,
      sourceSpaceKey: input.sourceSpaceKey ?? null,
      document: input.document,
      subject: input.subject,
    },
    { overwrite: input.overwrite }
  );
  if (!row) return { ok: false, reason: 'exists' };
  const template = fromRecord(row);
  if (!template) return { ok: false, reason: 'unreadable' };
  // A fresh insert stamps both times from one clock reading; a replaced row
  // keeps its original created_at.
  return {
    ok: true,
    template,
    replaced: template.createdAt.getTime() !== template.updatedAt.getTime(),
  };
}

/**
 * A template by id or by name. By name, this site's comes first; one saved
 * for another site is still returned, so the caller can say that rather
 * than "no such template".
 */
export async function findSpaceTemplate(
  cloudId: string,
  reference: string
): Promise<SpaceTemplate | null> {
  const wanted = reference.trim();
  if (!wanted) return null;
  const rows = await templates().find(
    cloudId,
    isUuid(wanted) ? { id: wanted } : { nameKey: nameKeyOf(wanted) }
  );
  const row = rows[0];
  return row ? fromRecord(row) : null;
}

/** Every template in the organization, by name. */
export async function listSpaceTemplates(): Promise<SpaceTemplate[]> {
  const rows = await templates().list(200);
  return rows.flatMap((row) => {
    const template = fromRecord(row);
    return template ? [template] : [];
  });
}

export async function deleteSpaceTemplate(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return templates().delete(id);
}

/**
 * How a live space differs from a template, in plain words — the drift
 * check. Reported, never corrected: which way to resolve a difference is a
 * person's call (docs/project-management-design.md, "Keeping spaces in
 * step"). People are not compared, since templates never hold them.
 */
export function templateDifferences(
  template: TemplateDocument,
  space: SpaceConfiguration
): string[] {
  const differences: string[] = [];
  if (template.projectTypeKey !== space.projectTypeKey) {
    differences.push(
      `Type: the template is ${template.projectTypeKey}, ${space.key} is ${space.projectTypeKey}.`
    );
  }
  for (const key of SCHEME_KEYS) {
    const want = template.schemes[key];
    const have = space.schemes[key];
    if ((want?.id ?? null) === (have?.id ?? null)) continue;
    const describe = (value: SchemeRef | null) => (value ? `“${value.name}”` : 'none');
    differences.push(
      `${SCHEME_LABELS[key].charAt(0).toUpperCase()}${SCHEME_LABELS[key].slice(1)}: the ` +
        `template has ${describe(want)}, ${space.key} has ${describe(have)}.`
    );
  }
  if ((template.assigneeType ?? null) !== (space.assigneeType ?? null)) {
    differences.push(
      `Default assignee: the template has ${template.assigneeType ?? 'Jira’s default'}, ` +
        `${space.key} has ${space.assigneeType ?? 'Jira’s default'}.`
    );
  }
  if ((template.category?.id ?? null) !== (space.category?.id ?? null)) {
    differences.push(
      `Category: the template has ${template.category ? `“${template.category.name}”` : 'none'}, ` +
        `${space.key} has ${space.category ? `“${space.category.name}”` : 'none'}.`
    );
  }
  const sameGroup = (a: { groupId: string; name: string }, b: { groupId: string; name: string }) =>
    (a.groupId && a.groupId === b.groupId) || a.name.toLowerCase() === b.name.toLowerCase();
  for (const role of template.roles) {
    const live = space.roles.find((candidate) => candidate.roleId === role.roleId);
    const missing = role.groups.filter(
      (group) => !(live?.groups ?? []).some((held) => sameGroup(group, held))
    );
    if (missing.length > 0) {
      differences.push(
        `${role.roleName}: ${space.key} is missing ${missing.map((group) => `group “${group.name}”`).join(', ')}.`
      );
    }
  }
  for (const role of space.roles) {
    const expected = template.roles.find((candidate) => candidate.roleId === role.roleId);
    const extra = role.groups.filter(
      (group) => !(expected?.groups ?? []).some((wanted) => sameGroup(group, wanted))
    );
    if (extra.length > 0) {
      differences.push(
        `${role.roleName}: ${space.key} also has ${extra.map((group) => `group “${group.name}”`).join(', ')}, which the template does not.`
      );
    }
  }
  // Components by name; a template saved before they were kept has no say.
  if (template.components) {
    const names = (list: { name: string }[]) => new Set(list.map((c) => c.name.toLowerCase()));
    const have = names(space.components);
    const want = names(template.components);
    const missing = template.components.filter((c) => !have.has(c.name.toLowerCase()));
    const extra = space.components.filter((c) => !want.has(c.name.toLowerCase()));
    const quoted = (list: { name: string }[]) => list.map((c) => `“${c.name}”`).join(', ');
    if (missing.length > 0) {
      differences.push(`Components: ${space.key} is missing ${quoted(missing)}.`);
    }
    if (extra.length > 0) {
      differences.push(
        `Components: ${space.key} also has ${quoted(extra)}, which the template does not.`
      );
    }
  }
  return differences;
}
