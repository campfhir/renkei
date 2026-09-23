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
 * named when it is created.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
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

export interface TemplateDocument {
  version: 1;
  projectTypeKey: string;
  assigneeType: string | null;
  category: { id: string; name: string } | null;
  schemes: SpaceSchemes;
  roles: TemplateRole[];
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
  };
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
  };
}

export function nameKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

const COLUMNS = [
  'id',
  'cloud_id',
  'site_url',
  'name',
  'description',
  'source_space_key',
  'document',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
] as const;

type Row = {
  id: string;
  cloud_id: string;
  site_url: string | null;
  name: string;
  description: string | null;
  source_space_key: string | null;
  document: unknown;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
};

/** A stored row, or null when its document is unreadable (and so unusable). */
function fromRow(row: Row): SpaceTemplate | null {
  const document = readTemplateDocument(row.document);
  if (!document) return null;
  return {
    id: row.id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
    name: row.name,
    description: row.description,
    sourceSpaceKey: row.source_space_key,
    document,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
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
export async function saveSpaceTemplate(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    cloudId: string;
    siteUrl?: string;
    name: string;
    description?: string;
    sourceSpaceKey?: string;
    document: TemplateDocument;
    subject: string;
    overwrite: boolean;
  }
): Promise<SaveResult> {
  const name = input.name.trim().slice(0, TEMPLATE_NAME_MAX);
  const values = {
    tenant_id: input.tenantId,
    cloud_id: input.cloudId,
    site_url: input.siteUrl || null,
    name,
    name_key: nameKeyOf(name),
    description: input.description?.trim() ? input.description.trim() : null,
    source_space_key: input.sourceSpaceKey ?? null,
    document: JSON.stringify(input.document),
    created_by: input.subject,
    updated_by: input.subject,
  };
  const insert = db.insertInto('jira_admin_space_templates').values(values);
  const target = ['tenant_id', 'cloud_id', 'name_key'] as const;
  // Without overwrite a taken name is left alone — ON CONFLICT DO NOTHING
  // returns no row, which is the answer, even when two saves race.
  const row = input.overwrite
    ? await insert
        .onConflict((conflict) =>
          conflict.columns([...target]).doUpdateSet({
            name: values.name,
            description: values.description,
            source_space_key: values.source_space_key,
            site_url: values.site_url,
            document: values.document,
            updated_by: input.subject,
            updated_at: sql<Date>`NOW()`,
          })
        )
        .returning(COLUMNS)
        .executeTakeFirst()
    : await insert
        .onConflict((conflict) => conflict.columns([...target]).doNothing())
        .returning(COLUMNS)
        .executeTakeFirst();
  if (!row) return { ok: false, reason: 'exists' };
  const template = fromRow(row);
  if (!template) return { ok: false, reason: 'unreadable' };
  // A fresh insert stamps both times from one NOW(); a replaced row keeps
  // its original created_at.
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
  db: Kysely<DB>,
  tenantId: string,
  cloudId: string,
  reference: string
): Promise<SpaceTemplate | null> {
  const wanted = reference.trim();
  if (!wanted) return null;
  const query = db
    .selectFrom('jira_admin_space_templates')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId);
  const rows = isUuid(wanted)
    ? await query.where('id', '=', wanted).execute()
    : await query.where('name_key', '=', nameKeyOf(wanted)).execute();
  const row = rows.find((candidate) => candidate.cloud_id === cloudId) ?? rows[0];
  return row ? fromRow(row) : null;
}

/** Every template in the organization, by name. */
export async function listSpaceTemplates(
  db: Kysely<DB>,
  tenantId: string
): Promise<SpaceTemplate[]> {
  const rows = await db
    .selectFrom('jira_admin_space_templates')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId)
    .orderBy('name_key')
    .limit(200)
    .execute();
  return rows.flatMap((row) => {
    const template = fromRow(row);
    return template ? [template] : [];
  });
}

export async function deleteSpaceTemplate(
  db: Kysely<DB>,
  tenantId: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .deleteFrom('jira_admin_space_templates')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
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
  return differences;
}
