/**
 * The onbase_admin_* tools — a SEPARATE connector from the onbase_* tools
 * in index.ts, wrapping OnBase's *Administration* API (Foundation 26.1,
 * docs/onbase-administration-openapi-spec.json) rather than its Document
 * API: it configures OnBase — document types, keyword types, the keyword
 * types assigned to a document type, document/keyword type groups, file
 * types, and the change-control audit log — instead of filing documents
 * into it.
 *
 * `onbase-admin` is its own Hyland OAuth client with its own
 * `connector_configs` row and its own `provider_grants` rows (see
 * onbase-auth.ts's ADMIN_SPEC and provider-grants' ONBASE_ADMIN), mirroring
 * how connector-atlassian treats Jira/JSM/Confluence/Bitbucket as four
 * separate connectors rather than one. A caller may have onbase_* without
 * onbase_admin_*, or the reverse — they are connected, enabled and
 * capability-gated independently. Because of that independence, this file
 * is fully self-contained: it never assumes the onbase_* Document
 * connector is also available, so every name→id resolution below (document
 * types, keyword types, groups, file types, disk groups) goes through the
 * Administration API's OWN listing endpoints (`GET /api/{kind}`), not
 * index.ts's Document-API-backed resolveRef/loadCatalog.
 *
 * Two things carry over from the Document API tools, because the shape of
 * the problem is the same:
 *
 *   - Names resolve to ids INSIDE the tools, with the same
 *     CatalogCache/resolveKeywordTypeRef machinery index.ts uses — just a
 *     second cache, scoped to this connector's own `/api/*` listings.
 *   - `PUT /api/document-types/{id}/keyword-types` REPLACES every keyword
 *     assignment on the document type, and reports success either way.
 *     onbase_admin_assign_keyword_types therefore reads the current
 *     assignments, merges the caller's changes in by keyword type id, and
 *     writes the whole collection back — the same trap, the same fix, as
 *     onbase_update_keywords in index.ts.
 *
 * A create or rename invalidates this file's own cache for that catalog
 * kind, so a document type created this turn resolves by name on the very
 * next tool call instead of waiting out five minutes of staleness.
 *
 * Users and user groups are READ here — list them, look one up, see who
 * is in a group and which document types a group may see — because the
 * Administration API keys every access grant by user group id and nothing
 * else in the connector could answer "what is the id of the Clinical
 * Staff group?". The one WRITE on that side is the document type ↔ user
 * group grant (and its document type group twin): in OnBase a document
 * type nobody has been granted is invisible everywhere, OnBase
 * Configuration included, so a document type created here without a user
 * group is one nobody can find — the exact "it has an id but does not show
 * up" symptom. Creating users or user groups, changing memberships, and
 * editing privileges/configuration rights stay out: that is identity and
 * rights management, a different risk class from document configuration.
 *
 * Deliberately not in this cut, matching the Document API tools' own
 * "nothing destructive, nothing security-adjacent in v1" scope: no deletes
 * anywhere (a document type or keyword type deleted on a model's say-so is
 * not a v1 capability); no password policies, EVM, Insight Discovery, key
 * providers, or security keywords (unrelated to "document types and
 * keywords", and each wants its own considered story); disk groups and file
 * types are read-only reference data here (an admin creates storage
 * infrastructure and viewer file types deliberately, not as a side effect
 * of filing documents); no PATCH update for document type groups or file
 * types (only document types and keyword types, the two things this cut is
 * actually for).
 *
 * Unverified against a real Foundation server, per onbase-connector-design.md's
 * own caveat — this connector has no public sandbox equivalent to Atlassian
 * or Zoom's developer tenants, so first contact is first deployment.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { CatalogCache, resolveKeywordTypeRef } from '@renkei/connector-onbase';
import type { MCPToolContext } from '../common';
import type { OnBaseAuth } from './onbase-auth';
import {
  apiJson,
  displayName,
  errText,
  isRecord,
  namedList,
  str,
  textResult,
  type NamedThing,
} from './index';

type AdminCatalogKind =
  | 'document-types'
  | 'keyword-types'
  | 'document-type-groups'
  | 'keyword-type-groups'
  | 'file-types'
  | 'disk-groups'
  | 'user-groups'
  | 'users';

/**
 * Every paged listing takes `limit`, where 0 means "everything". A catalog
 * used for name resolution needs the whole vocabulary, not the server's
 * first page — the 101st document type must resolve too. Disk groups are
 * the one listing with no paging parameters.
 */
function listingQuery(kind: AdminCatalogKind): Record<string, string> | undefined {
  return kind === 'disk-groups' ? undefined : { limit: '0' };
}

/**
 * This connector's own vocabulary cache — a second instance from index.ts's,
 * because this connector's `auth` reaches a different host (the
 * Administration API) and may exist without the Document connector at all.
 * Five minutes of staleness on admin-curated configuration, same tradeoff
 * as index.ts.
 */
const adminCatalogCache = new CatalogCache<NamedThing[]>();

async function loadAdminCatalog(
  context: MCPToolContext,
  auth: OnBaseAuth,
  kind: AdminCatalogKind
): Promise<NamedThing[] | string> {
  const cacheKey = `${context.tenantId}:${kind}`;
  const cached = adminCatalogCache.get(cacheKey);
  if (cached) return cached;
  const result = await apiJson(
    auth,
    { method: 'GET', path: `/api/${kind}`, query: listingQuery(kind) },
    `list ${kind}`
  );
  if (typeof result === 'string') return result;
  const items = namedList(result.json);
  adminCatalogCache.set(cacheKey, items);
  return items;
}

/** Drop a cached page so the next resolveAdminRef re-fetches it after a write. */
function invalidateAdminCatalog(context: MCPToolContext, kind: AdminCatalogKind): void {
  adminCatalogCache.invalidate(`${context.tenantId}:${kind}`);
}

async function resolveAdminRef(
  context: MCPToolContext,
  auth: OnBaseAuth,
  kind: AdminCatalogKind,
  ref: string,
  noun: string
): Promise<string | { refusal: string }> {
  const catalog = await loadAdminCatalog(context, auth, kind);
  if (typeof catalog === 'string') return { refusal: catalog };
  const resolved = resolveKeywordTypeRef(catalog, ref, noun);
  if (!resolved.ok) return { refusal: resolved.err.message ?? `Unknown ${noun}: ${ref}` };
  return resolved.val;
}

/** JSON Patch from a flat field-name → new-value object; every op is "replace". */
function replacePatch(
  fields: Record<string, unknown>
): { op: 'replace'; path: string; value: unknown }[] {
  return Object.entries(fields).map(([key, value]) => ({
    op: 'replace' as const,
    path: `/${key}`,
    value,
  }));
}

/**
 * The Administration API hands every id back as a string, but DocumentType
 * declares documentTypeGroupId, defaultDiskGroupId and defaultFileFormatId
 * as numbers and the POST models take userGroupIds/userIds as integers.
 * Send what the schema declares; a non-numeric id (none are expected) is
 * passed through untouched rather than turned into NaN.
 */
function numericId(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}

/** Resolve user group names or ids to ids, refusing on the first unknown one. */
async function resolveUserGroupIds(
  context: MCPToolContext,
  auth: OnBaseAuth,
  refs: readonly string[]
): Promise<string[] | { refusal: string }> {
  const ids: string[] = [];
  for (const ref of refs) {
    const id = await resolveAdminRef(context, auth, 'user-groups', ref, 'user group');
    if (typeof id !== 'string') return id;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** id → display name for one catalog kind, for rendering assignment rows; empty when the listing fails. */
async function adminNames(
  context: MCPToolContext,
  auth: OnBaseAuth,
  kind: AdminCatalogKind
): Promise<Map<string, string>> {
  const catalog = await loadAdminCatalog(context, auth, kind);
  return new Map(typeof catalog === 'string' ? [] : catalog.map((t) => [t.id, displayName(t)]));
}

function labelled(names: Map<string, string>, id: string, noun: string): string {
  const name = names.get(id);
  return name ? `${name} (id ${id})` : `${noun} ${id}`;
}

/** The `items[]` of an assignment collection, or [] for anything else. */
function assignmentItems(json: unknown): Record<string, unknown>[] {
  return isRecord(json) && Array.isArray(json.items) ? json.items.filter(isRecord) : [];
}

/**
 * The warning every document type created without a user group carries.
 * OnBase shows a document type only to members of a user group it has been
 * granted to — in every client AND in OnBase Configuration — so an
 * ungranted document type exists (it has an id, it is in the audit log) but
 * nobody can see it, the caller's own account included.
 */
const UNGRANTED_DOCUMENT_TYPE_NOTE =
  'No user group has been granted it yet, so it will not appear in OnBase Configuration or in ' +
  'any OnBase client for anyone — including you — until one is. Grant it with ' +
  'onbase_admin_assign_document_type_user_groups (onbase_admin_list_user_groups shows the ' +
  'groups). OnBase Configuration also loads its lists at sign-in: restart it to see changes ' +
  'made through this API.';

const userGroupsSchema = z
  .array(z.string().min(1))
  .optional()
  .describe(
    'User groups to grant this to immediately, by name or id (onbase_admin_list_user_groups ' +
      'shows them).'
  );

const optionsSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Any other field from the OnBase Administration API schema, passed through verbatim ' +
      '(docs/onbase-administration-openapi-spec.json). Named parameters above always win over ' +
      'a same-named entry here.'
  );

export const ONBASE_ADMIN_MCP_CONNECTOR = 'onbase-admin';

export function registerOnbaseAdminTools(
  server: McpServer,
  context: MCPToolContext,
  auth: OnBaseAuth
): void {
  /* ------------------------------- Read ------------------------------- */

  server.registerTool(
    'onbase_admin_list_document_types',
    {
      title: 'OnBase Admin · Read — List document types',
      description:
        'The document types configured in this OnBase, by name and id — the vocabulary every ' +
        'other onbase_admin_* tool resolves names against.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const types = await loadAdminCatalog(context, auth, 'document-types');
      if (typeof types === 'string') return errText(types);
      if (types.length === 0) return textResult('No document types are visible to your account.');
      return textResult(
        'Document types (name — id):\n' +
          types.map((t) => `  ${displayName(t)} — id ${t.id}`).join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_list_keyword_types',
    {
      title: 'OnBase Admin · Read — List keyword types',
      description:
        'The keyword types configured in this OnBase, by name and id — the vocabulary every ' +
        'other onbase_admin_* tool resolves names against.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const types = await loadAdminCatalog(context, auth, 'keyword-types');
      if (typeof types === 'string') return errText(types);
      if (types.length === 0) return textResult('No keyword types are visible to your account.');
      return textResult(
        'Keyword types (name — id):\n' +
          types.map((t) => `  ${displayName(t)} — id ${t.id}`).join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_get_document_type',
    {
      title: 'OnBase Admin · Read — Document type configuration',
      description:
        'The full configuration of one document type — every field the Administration API ' +
        'exposes (disk group, default file format, retrieval/display behavior), not just the ' +
        'name and id onbase_admin_list_document_types shows. Use before ' +
        'onbase_admin_update_document_type to see current values.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
      }),
    },
    async (args: { documentType: string }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'document-types',
        args.documentType,
        'document type'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/api/document-types/${encodeURIComponent(id)}` },
        'read the document type'
      );
      if (typeof result === 'string') return errText(result);
      return textResult(JSON.stringify(result.json, null, 2));
    }
  );

  server.registerTool(
    'onbase_admin_get_keyword_type',
    {
      title: 'OnBase Admin · Read — Keyword type configuration',
      description:
        'The full configuration of one keyword type — data type, casing, storage, dataset ' +
        'settings — not just the name and id onbase_admin_list_keyword_types shows. Use before ' +
        'onbase_admin_update_keyword_type to see current values.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        keywordType: z.string().min(1).describe('Keyword type name or id.'),
      }),
    },
    async (args: { keywordType: string }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'keyword-types',
        args.keywordType,
        'keyword type'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/api/keyword-types/${encodeURIComponent(id)}` },
        'read the keyword type'
      );
      if (typeof result === 'string') return errText(result);
      return textResult(JSON.stringify(result.json, null, 2));
    }
  );

  server.registerTool(
    'onbase_admin_get_document_type_group',
    {
      title: 'OnBase Admin · Read — Document type group configuration',
      description: 'The full configuration of one document type group.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentTypeGroup: z.string().min(1).describe('Document type group name or id.'),
      }),
    },
    async (args: { documentTypeGroup: string }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'document-type-groups',
        args.documentTypeGroup,
        'document type group'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/api/document-type-groups/${encodeURIComponent(id)}` },
        'read the document type group'
      );
      if (typeof result === 'string') return errText(result);
      return textResult(JSON.stringify(result.json, null, 2));
    }
  );

  server.registerTool(
    'onbase_admin_get_keyword_type_group',
    {
      title: 'OnBase Admin · Read — Keyword type group configuration',
      description: 'The full configuration of one keyword type group.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        keywordTypeGroup: z.string().min(1).describe('Keyword type group name or id.'),
      }),
    },
    async (args: { keywordTypeGroup: string }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'keyword-type-groups',
        args.keywordTypeGroup,
        'keyword type group'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/api/keyword-type-groups/${encodeURIComponent(id)}` },
        'read the keyword type group'
      );
      if (typeof result === 'string') return errText(result);
      return textResult(JSON.stringify(result.json, null, 2));
    }
  );

  server.registerTool(
    'onbase_admin_get_file_type',
    {
      title: 'OnBase Admin · Read — File type configuration',
      description:
        'The full configuration of one file type (display type, extension, viewer options).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        fileType: z.string().min(1).describe('File type name or id.'),
      }),
    },
    async (args: { fileType: string }) => {
      const id = await resolveAdminRef(context, auth, 'file-types', args.fileType, 'file type');
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/api/file-types/${encodeURIComponent(id)}` },
        'read the file type'
      );
      if (typeof result === 'string') return errText(result);
      return textResult(JSON.stringify(result.json, null, 2));
    }
  );

  server.registerTool(
    'onbase_admin_list_file_types',
    {
      title: 'OnBase Admin · Read — List file types',
      description:
        'The file types configured in this OnBase, by name and id — the vocabulary ' +
        "onbase_admin_create_document_type's defaultFileFormat resolves names against.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const types = await loadAdminCatalog(context, auth, 'file-types');
      if (typeof types === 'string') return errText(types);
      if (types.length === 0) return textResult('No file types are visible to your account.');
      return textResult(
        'File types (name — id):\n' +
          types.map((t) => `  ${displayName(t)} — id ${t.id}`).join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_list_disk_groups',
    {
      title: 'OnBase Admin · Read — List disk groups',
      description:
        'The disk groups configured in this OnBase, by name and id — required to create a ' +
        'document type (its defaultDiskGroup). Disk groups themselves are not created here: ' +
        "they're storage infrastructure an OnBase admin sets up deliberately, not a byproduct " +
        'of configuring document types.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const groups = await loadAdminCatalog(context, auth, 'disk-groups');
      if (typeof groups === 'string') return errText(groups);
      if (groups.length === 0) return textResult('No disk groups are visible to your account.');
      return textResult(
        'Disk groups (name — id):\n' +
          groups.map((g) => `  ${displayName(g)} — id ${g.id}`).join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_list_display_types',
    {
      title: 'OnBase Admin · Read — List display types',
      description:
        'The valid displayType values for onbase_admin_create_file_type (e.g. "Pdf", "Text", ' +
        '"Image") — a plain string on FileType, not an id reference, but only these values are ' +
        'meaningful to OnBase.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const result = await apiJson(
        auth,
        { method: 'GET', path: '/api/file-types/display-types' },
        'list display types'
      );
      if (typeof result === 'string') return errText(result);
      const items = namedList(result.json);
      if (items.length === 0) return textResult('No display types were returned.');
      return textResult('Display types:\n' + items.map((t) => `  ${displayName(t)}`).join('\n'));
    }
  );

  server.registerTool(
    'onbase_admin_get_document_type_keywords',
    {
      title: 'OnBase Admin · Read — Keyword types assigned to a document type',
      description:
        'Every keyword type currently assigned to a document type, with its per-assignment ' +
        'settings (required, hidden, default value, keyword type group). ' +
        'onbase_admin_assign_keyword_types changes this set.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
      }),
    },
    async (args: { documentType: string }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'document-types',
        args.documentType,
        'document type'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const rendered = await renderAssignments(context, auth, id);
      return rendered.ok ? textResult(rendered.text) : errText(rendered.text);
    }
  );

  server.registerTool(
    'onbase_admin_list_change_events',
    {
      title: 'OnBase Admin · Read — Configuration change audit log',
      description:
        'Who changed what configuration and when — document types, keyword types, and the rest ' +
        'of what the Administration API tracks. All filters are optional and combine as AND.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        itemName: z.string().optional().describe('The configuration item name to filter to.'),
        author: z.string().optional().describe('The user id who made the change.'),
        changeType: z.enum(['Create', 'Update', 'Delete']).optional(),
        after: z.string().optional().describe('Lower bound, e.g. "2026-08-27 00:00:00.000".'),
        before: z.string().optional().describe('Upper bound, same format.'),
      }),
    },
    async (args: {
      itemName?: string;
      author?: string;
      changeType?: 'Create' | 'Update' | 'Delete';
      after?: string;
      before?: string;
    }) => {
      const query: Record<string, string> = {};
      if (args.itemName) query.itemName = args.itemName;
      if (args.author) query.author = args.author;
      if (args.changeType) query.changeType = args.changeType;
      if (args.after) query.afterDateChanged = args.after;
      if (args.before) query.beforeDateChanged = args.before;
      const result = await apiJson(
        auth,
        { method: 'GET', path: '/api/change-events', query },
        'list change events'
      );
      if (typeof result === 'string') return errText(result);
      const items =
        isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
      if (items.length === 0) return textResult('No matching change events.');
      const lines = items.filter(isRecord).map((event) => {
        const item = isRecord(event.changeItem) ? event.changeItem : {};
        const who = str(event.changeAuthorUserName) || `user ${str(event.changeAuthor) || '?'}`;
        return (
          `  ${str(event.dateChanged) || '?'} — ${str(item.changeType) || '?'} ${str(item.itemType) || '?'} ` +
          `"${str(item.itemName) || '?'}" (id ${str(item.itemId) || '?'}) by ${who}`
        );
      });
      return textResult(`Change events:\n${lines.join('\n')}`);
    }
  );

  /* ------------------------ Users and user groups ------------------------ */

  server.registerTool(
    'onbase_admin_list_user_groups',
    {
      title: 'OnBase Admin · Read — List user groups',
      description:
        'The user groups configured in this OnBase, by name and id — the ids every access ' +
        'grant is keyed by (userGroups on onbase_admin_create_document_type, ' +
        'onbase_admin_assign_document_type_user_groups). Every other tool also accepts a ' +
        'group by name, so this is mostly for browsing.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        nameContains: z
          .string()
          .optional()
          .describe('Only groups whose name contains this text (case-insensitive).'),
      }),
    },
    async (args: { nameContains?: string }) => {
      const groups = await loadAdminCatalog(context, auth, 'user-groups');
      if (typeof groups === 'string') return errText(groups);
      const wanted = args.nameContains?.trim().toLowerCase();
      const shown = wanted
        ? groups.filter((g) => displayName(g).toLowerCase().includes(wanted))
        : groups;
      if (shown.length === 0) {
        return textResult(
          wanted
            ? `No user group name contains "${args.nameContains}" (${groups.length} visible).`
            : 'No user groups are visible to your account.'
        );
      }
      return textResult(
        'User groups (name — id):\n' +
          shown.map((g) => `  ${displayName(g)} — id ${g.id}`).join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_list_users',
    {
      title: 'OnBase Admin · Read — List users',
      description:
        'The user accounts in this OnBase, by user name and id. Service accounts (the ones ' +
        'services and integrations sign in as) are left out unless asked for.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        nameContains: z
          .string()
          .optional()
          .describe('Only users whose user name contains this text (case-insensitive).'),
        includeServiceAccounts: z.boolean().optional().describe('Default false.'),
      }),
    },
    async (args: { nameContains?: string; includeServiceAccounts?: boolean }) => {
      // Not the cached catalog: the listing's isServiceAccount flag matters
      // here and NamedThing has no room for it.
      const result = await apiJson(
        auth,
        { method: 'GET', path: '/api/users', query: listingQuery('users') },
        'list users'
      );
      if (typeof result === 'string') return errText(result);
      const wanted = args.nameContains?.trim().toLowerCase();
      const users = assignmentItems(result.json).filter((u) => typeof u.id === 'string');
      const shown = users.filter(
        (u) =>
          (args.includeServiceAccounts || u.isServiceAccount !== true) &&
          (!wanted || str(u.name).toLowerCase().includes(wanted))
      );
      if (shown.length === 0) {
        return textResult(
          wanted
            ? `No user name contains "${args.nameContains}" (${users.length} visible).`
            : 'No users are visible to your account.'
        );
      }
      return textResult(
        'Users (user name — id):\n' +
          shown
            .map(
              (u) =>
                `  ${str(u.name) || '(unnamed)'} — id ${str(u.id)}` +
                (u.isServiceAccount === true ? ' [service account]' : '')
            )
            .join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_get_user_group',
    {
      title: 'OnBase Admin · Read — User group and its members',
      description:
        "One user group's configuration and the users who are members of it. " +
        'onbase_admin_list_user_group_access shows what the group may see.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        userGroup: z.string().min(1).describe('User group name or id.'),
      }),
    },
    async (args: { userGroup: string }) => {
      const id = await resolveAdminRef(context, auth, 'user-groups', args.userGroup, 'user group');
      if (typeof id !== 'string') return errText(id.refusal);
      const group = await apiJson(
        auth,
        { method: 'GET', path: `/api/user-groups/${encodeURIComponent(id)}` },
        'read the user group'
      );
      if (typeof group === 'string') return errText(group);
      const members = await apiJson(
        auth,
        { method: 'GET', path: '/api/users/user-groups', query: { userGroupId: id } },
        "read the user group's members"
      );
      if (typeof members === 'string') return errText(members);
      const userNames = await adminNames(context, auth, 'users');
      const memberIds = assignmentItems(members.json)
        .map((m) => str(m.userId))
        .filter((userId) => userId !== '');
      const lines =
        memberIds.length === 0
          ? ['  (no members)']
          : memberIds.map((userId) => `  ${labelled(userNames, userId, 'user')}`);
      return textResult(
        `${JSON.stringify(group.json, null, 2)}\n\nMembers (${memberIds.length}):\n${lines.join('\n')}`
      );
    }
  );

  server.registerTool(
    'onbase_admin_get_user',
    {
      title: 'OnBase Admin · Read — User and their user groups',
      description:
        "One user account's configuration (never its password) and the user groups it belongs " +
        'to — which is what decides the document types that person can see.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        user: z.string().min(1).describe('User name or id.'),
      }),
    },
    async (args: { user: string }) => {
      const id = await resolveAdminRef(context, auth, 'users', args.user, 'user');
      if (typeof id !== 'string') return errText(id.refusal);
      const user = await apiJson(
        auth,
        { method: 'GET', path: `/api/users/${encodeURIComponent(id)}` },
        'read the user'
      );
      if (typeof user === 'string') return errText(user);
      const memberships = await apiJson(
        auth,
        { method: 'GET', path: '/api/users/user-groups', query: { userId: id } },
        "read the user's group memberships"
      );
      if (typeof memberships === 'string') return errText(memberships);
      const groupNames = await adminNames(context, auth, 'user-groups');
      const groupIds = assignmentItems(memberships.json)
        .map((m) => str(m.userGroupId))
        .filter((groupId) => groupId !== '');
      const lines =
        groupIds.length === 0
          ? ['  (none)']
          : groupIds.map((groupId) => `  ${labelled(groupNames, groupId, 'user group')}`);
      const shown = isRecord(user.json) ? { ...user.json, password: undefined } : user.json;
      return textResult(
        `${JSON.stringify(shown, null, 2)}\n\nUser groups (${groupIds.length}):\n${lines.join('\n')}`
      );
    }
  );

  server.registerTool(
    'onbase_admin_list_user_group_access',
    {
      title: 'OnBase Admin · Read — Who may see a document type',
      description:
        'The document type ↔ user group grants that decide visibility in OnBase. Ask from ' +
        'either side: give a userGroup to see every document type and document type group it ' +
        'has been granted, or a documentType / documentTypeGroup to see which user groups have ' +
        'been granted it. A document type with no user groups is invisible to everyone, OnBase ' +
        'Configuration included — the usual reason a newly created one "does not show up".',
      annotations: { readOnlyHint: true },
      inputSchema: z
        .object({
          userGroup: z.string().min(1).optional().describe('User group name or id.'),
          documentType: z.string().min(1).optional().describe('Document type name or id.'),
          documentTypeGroup: z
            .string()
            .min(1)
            .optional()
            .describe('Document type group name or id.'),
        })
        .refine(
          (a) => [a.userGroup, a.documentType, a.documentTypeGroup].filter(Boolean).length === 1,
          { message: 'Give exactly one of userGroup, documentType or documentTypeGroup.' }
        ),
    },
    async (args: { userGroup?: string; documentType?: string; documentTypeGroup?: string }) => {
      const given = [args.userGroup, args.documentType, args.documentTypeGroup].filter(Boolean);
      if (given.length !== 1) {
        return errText('Give exactly one of userGroup, documentType or documentTypeGroup.');
      }

      if (args.userGroup) {
        const id = await resolveAdminRef(
          context,
          auth,
          'user-groups',
          args.userGroup,
          'user group'
        );
        if (typeof id !== 'string') return errText(id.refusal);
        const [types, groups] = await Promise.all([
          apiJson(
            auth,
            { method: 'GET', path: '/api/document-types/user-groups', query: { userGroupId: id } },
            "read the user group's document types"
          ),
          apiJson(
            auth,
            {
              method: 'GET',
              path: '/api/document-type-groups/user-groups',
              query: { userGroupId: id },
            },
            "read the user group's document type groups"
          ),
        ]);
        if (typeof types === 'string') return errText(types);
        if (typeof groups === 'string') return errText(groups);
        const typeNames = await adminNames(context, auth, 'document-types');
        const groupNames = await adminNames(context, auth, 'document-type-groups');
        const typeIds = assignmentItems(types.json)
          .map((a) => str(a.documentTypeId))
          .filter(Boolean);
        const groupIds = assignmentItems(groups.json)
          .map((a) => str(a.documentTypeGroupId))
          .filter(Boolean);
        return textResult(
          `User group ${args.userGroup} (id ${id}) may see:\n` +
            `Document types (${typeIds.length}):\n` +
            (typeIds.length
              ? typeIds.map((t) => `  ${labelled(typeNames, t, 'document type')}`).join('\n')
              : '  (none)') +
            `\nDocument type groups (${groupIds.length}):\n` +
            (groupIds.length
              ? groupIds
                  .map((g) => `  ${labelled(groupNames, g, 'document type group')}`)
                  .join('\n')
              : '  (none)')
        );
      }

      const groupNames = await adminNames(context, auth, 'user-groups');
      const renderGroups = (ids: string[], subject: string) =>
        ids.length === 0
          ? `${subject} has been granted to NO user groups — nobody can see it, OnBase ` +
            'Configuration included. Grant it with ' +
            (args.documentType
              ? 'onbase_admin_assign_document_type_user_groups.'
              : 'onbase_admin_assign_document_type_group_user_groups.')
          : `${subject} is granted to ${ids.length} user group(s):\n` +
            ids.map((g) => `  ${labelled(groupNames, g, 'user group')}`).join('\n');

      if (args.documentType) {
        const id = await resolveAdminRef(
          context,
          auth,
          'document-types',
          args.documentType,
          'document type'
        );
        if (typeof id !== 'string') return errText(id.refusal);
        const current = await documentTypeUserGroups(auth, id);
        if (typeof current === 'string') return errText(current);
        return textResult(renderGroups(current, `Document type ${args.documentType} (id ${id})`));
      }

      const id = await resolveAdminRef(
        context,
        auth,
        'document-type-groups',
        args.documentTypeGroup!,
        'document type group'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const current = await documentTypeGroupUserGroups(auth, id);
      if (typeof current === 'string') return errText(current);
      return textResult(
        renderGroups(current, `Document type group ${args.documentTypeGroup} (id ${id})`)
      );
    }
  );

  server.registerTool(
    'onbase_admin_get_my_permissions',
    {
      title: 'OnBase Admin · Read — My rights in OnBase',
      description:
        'The product rights, configuration rights and privileges OnBase grants the connected ' +
        'account — what this connection can and cannot configure. Check here first when a ' +
        'tool answers 403, or to see whether a licensed product (Medical Records, Physician ' +
        'Portal, Patient Portal, Records Management, Workflow…) is enabled for you.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const result = await apiJson(
        auth,
        { method: 'GET', path: '/api/users/me/permissions' },
        'read your permissions'
      );
      if (typeof result === 'string') return errText(result);
      return textResult(JSON.stringify(result.json, null, 2));
    }
  );

  /* ------------------------------- Act -------------------------------- */

  server.registerTool(
    'onbase_admin_create_document_type',
    {
      title: 'OnBase Admin · Act — Create a document type',
      description:
        'Create a new document type. documentTypeGroup, defaultFileFormat and defaultDiskGroup ' +
        'are required by OnBase and are resolved from names (onbase_admin_list_document_types, ' +
        'onbase_admin_list_file_types, onbase_admin_list_disk_groups show the vocabulary). ' +
        'Pass userGroups too: OnBase shows a document type only to members of a user group it ' +
        'has been granted to, so one created without any is invisible everywhere (OnBase ' +
        'Configuration included) until onbase_admin_assign_document_type_user_groups grants it. ' +
        'Keyword types are NOT assigned at creation — call onbase_admin_assign_keyword_types ' +
        'afterward.',
      inputSchema: z.object({
        name: z.string().min(1),
        documentTypeGroup: z.string().min(1).describe('Document type group name or id.'),
        defaultFileFormat: z.string().min(1).describe('File type name or id.'),
        defaultDiskGroup: z.string().min(1).describe('Disk group name or id.'),
        autoNameString: z.string().optional(),
        allowMarkUp: z.boolean().optional(),
        cachingAllowed: z.boolean().optional(),
        thumbnailsEnabled: z.boolean().optional(),
        retrievalListSortOrder: z
          .enum(['None', 'DateDescending', 'DateAscending', 'HandleDescending', 'HandleAscending'])
          .optional(),
        userGroups: userGroupsSchema,
        userGroupIds: z
          .array(z.string())
          .optional()
          .describe('Older spelling of userGroups; ids only. Prefer userGroups.'),
        options: optionsSchema,
      }),
    },
    async (args: {
      name: string;
      documentTypeGroup: string;
      defaultFileFormat: string;
      defaultDiskGroup: string;
      autoNameString?: string;
      allowMarkUp?: boolean;
      cachingAllowed?: boolean;
      thumbnailsEnabled?: boolean;
      retrievalListSortOrder?: string;
      userGroups?: string[];
      userGroupIds?: string[];
      options?: Record<string, unknown>;
    }) => {
      const groupId = await resolveAdminRef(
        context,
        auth,
        'document-type-groups',
        args.documentTypeGroup,
        'document type group'
      );
      if (typeof groupId !== 'string') return errText(groupId.refusal);
      const fileFormatId = await resolveAdminRef(
        context,
        auth,
        'file-types',
        args.defaultFileFormat,
        'file type'
      );
      if (typeof fileFormatId !== 'string') return errText(fileFormatId.refusal);
      const diskGroupId = await resolveAdminRef(
        context,
        auth,
        'disk-groups',
        args.defaultDiskGroup,
        'disk group'
      );
      if (typeof diskGroupId !== 'string') return errText(diskGroupId.refusal);
      const userGroupIds = await resolveUserGroupIds(context, auth, [
        ...(args.userGroups ?? []),
        ...(args.userGroupIds ?? []),
      ]);
      if (!Array.isArray(userGroupIds)) return errText(userGroupIds.refusal);

      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        documentTypeGroupId: numericId(groupId),
        defaultFileFormatId: numericId(fileFormatId),
        defaultDiskGroupId: numericId(diskGroupId),
        ...(args.autoNameString !== undefined ? { autoNameString: args.autoNameString } : {}),
        ...(args.allowMarkUp !== undefined ? { allowMarkUp: args.allowMarkUp } : {}),
        ...(args.cachingAllowed !== undefined ? { cachingAllowed: args.cachingAllowed } : {}),
        ...(args.thumbnailsEnabled !== undefined
          ? { thumbnailsEnabled: args.thumbnailsEnabled }
          : {}),
        ...(args.retrievalListSortOrder
          ? { retrievalListSortOrder: args.retrievalListSortOrder }
          : {}),
        ...(userGroupIds.length > 0 ? { userGroupIds: userGroupIds.map(numericId) } : {}),
      };

      const created = await apiJson(
        auth,
        { method: 'POST', path: '/api/document-types', body },
        'create the document type'
      );
      if (typeof created === 'string') return errText(created);
      invalidateAdminCatalog(context, 'document-types');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      const groupNames = await adminNames(context, auth, 'user-groups');
      const granted =
        userGroupIds.length > 0
          ? `Granted to ${userGroupIds.length} user group(s): ` +
            userGroupIds.map((id) => labelled(groupNames, id, 'user group')).join(', ') +
            '.'
          : UNGRANTED_DOCUMENT_TYPE_NOTE;
      return textResult(
        `Created document type "${args.name}"${newId ? ` (id ${newId})` : ''}. ${granted} Use ` +
          'onbase_admin_assign_keyword_types to add keywords to it.'
      );
    }
  );

  server.registerTool(
    'onbase_admin_update_document_type',
    {
      title: 'OnBase Admin · Act — Update a document type',
      description:
        'Change fields on an existing document type. Only the fields named in `fields` change ' +
        "(each is a top-level property from onbase_admin_get_document_type's output, e.g. " +
        '{"cachingAllowed": true, "autoNameString": "%N - %D2"}) — everything else is left as is.',
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
        fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
          message: 'fields must name at least one property to change.',
        }),
      }),
    },
    async (args: { documentType: string; fields: Record<string, unknown> }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'document-types',
        args.documentType,
        'document type'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const updated = await apiJson(
        auth,
        {
          method: 'PATCH',
          path: `/api/document-types/${encodeURIComponent(id)}`,
          body: replacePatch(args.fields),
        },
        'update the document type'
      );
      if (typeof updated === 'string') return errText(updated);
      if (args.fields.name !== undefined) invalidateAdminCatalog(context, 'document-types');
      return textResult(
        `Updated document type ${args.documentType}: ${Object.keys(args.fields).join(', ')}.`
      );
    }
  );

  server.registerTool(
    'onbase_admin_create_keyword_type',
    {
      title: 'OnBase Admin · Act — Create a keyword type',
      description:
        'Create a new keyword type. dataType is required by OnBase and cannot change later.',
      inputSchema: z.object({
        name: z.string().min(1),
        dataType: z.enum([
          'Numeric9',
          'Numeric20',
          'Alphanumeric',
          'Currency',
          'SpecificCurrency',
          'Date',
          'DateTime',
          'FloatingPoint',
        ]),
        casing: z.enum(['Upper', 'Mixed']).optional(),
        maxLength: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only for Alphanumeric; the max stored string length.'),
        storage: z.enum(['SingleTable', 'DualTable']).optional(),
        usageRestrictions: z.enum(['None', 'Unique', 'Exist']).optional(),
        options: optionsSchema,
      }),
    },
    async (args: {
      name: string;
      dataType: string;
      casing?: string;
      maxLength?: number;
      storage?: string;
      usageRestrictions?: string;
      options?: Record<string, unknown>;
    }) => {
      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        dataType: args.dataType,
        ...(args.casing ? { casing: args.casing } : {}),
        ...(args.maxLength !== undefined ? { maxLength: args.maxLength } : {}),
        ...(args.storage ? { storage: args.storage } : {}),
        ...(args.usageRestrictions ? { usageRestrictions: args.usageRestrictions } : {}),
      };
      const created = await apiJson(
        auth,
        { method: 'POST', path: '/api/keyword-types', body },
        'create the keyword type'
      );
      if (typeof created === 'string') return errText(created);
      invalidateAdminCatalog(context, 'keyword-types');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(`Created keyword type "${args.name}"${newId ? ` (id ${newId})` : ''}.`);
    }
  );

  server.registerTool(
    'onbase_admin_update_keyword_type',
    {
      title: 'OnBase Admin · Act — Update a keyword type',
      description:
        'Change fields on an existing keyword type. Only the fields named in `fields` change ' +
        "(top-level properties from onbase_admin_get_keyword_type's output) — everything else " +
        'is left as is. dataType cannot be changed once documents use this keyword type.',
      inputSchema: z.object({
        keywordType: z.string().min(1).describe('Keyword type name or id.'),
        fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
          message: 'fields must name at least one property to change.',
        }),
      }),
    },
    async (args: { keywordType: string; fields: Record<string, unknown> }) => {
      const id = await resolveAdminRef(
        context,
        auth,
        'keyword-types',
        args.keywordType,
        'keyword type'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const updated = await apiJson(
        auth,
        {
          method: 'PATCH',
          path: `/api/keyword-types/${encodeURIComponent(id)}`,
          body: replacePatch(args.fields),
        },
        'update the keyword type'
      );
      if (typeof updated === 'string') return errText(updated);
      if (args.fields.name !== undefined) invalidateAdminCatalog(context, 'keyword-types');
      return textResult(
        `Updated keyword type ${args.keywordType}: ${Object.keys(args.fields).join(', ')}.`
      );
    }
  );

  server.registerTool(
    'onbase_admin_create_document_type_group',
    {
      title: 'OnBase Admin · Act — Create a document type group',
      description: 'Create a new document type group — the folder new document types file into.',
      inputSchema: z.object({
        name: z.string().min(1).max(65),
        documentSource: z.enum(['Normal', 'GroupEnabled', 'OleAPI', 'DMA', 'Catalog']).optional(),
        userGroups: userGroupsSchema,
        userGroupIds: z
          .array(z.string())
          .optional()
          .describe('Older spelling of userGroups; ids only. Prefer userGroups.'),
        options: optionsSchema,
      }),
    },
    async (args: {
      name: string;
      documentSource?: string;
      userGroups?: string[];
      userGroupIds?: string[];
      options?: Record<string, unknown>;
    }) => {
      const userGroupIds = await resolveUserGroupIds(context, auth, [
        ...(args.userGroups ?? []),
        ...(args.userGroupIds ?? []),
      ]);
      if (!Array.isArray(userGroupIds)) return errText(userGroupIds.refusal);
      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        ...(args.documentSource ? { documentSource: args.documentSource } : {}),
        ...(userGroupIds.length > 0 ? { userGroupIds: userGroupIds.map(numericId) } : {}),
      };
      const created = await apiJson(
        auth,
        { method: 'POST', path: '/api/document-type-groups', body },
        'create the document type group'
      );
      if (typeof created === 'string') return errText(created);
      invalidateAdminCatalog(context, 'document-type-groups');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(
        `Created document type group "${args.name}"${newId ? ` (id ${newId})` : ''}.`
      );
    }
  );

  server.registerTool(
    'onbase_admin_create_keyword_type_group',
    {
      title: 'OnBase Admin · Act — Create a keyword type group',
      description:
        'Create a new keyword type group, bundling existing keyword types into it in one call — ' +
        'OnBase requires the member list at creation time. Keyword types are given by name or id.',
      inputSchema: z.object({
        name: z.string().min(1),
        keywordTypes: z
          .array(
            z.object({
              keywordType: z.string().min(1).describe('Keyword type name or id.'),
              sequenceNum: z.number().int().min(0),
            })
          )
          .min(1),
        multiInstanceKeywordTypeGroup: z.boolean().optional(),
        nullAllowed: z.boolean().optional(),
        dateStored: z.boolean().optional(),
        options: optionsSchema,
      }),
    },
    async (args: {
      name: string;
      keywordTypes: { keywordType: string; sequenceNum: number }[];
      multiInstanceKeywordTypeGroup?: boolean;
      nullAllowed?: boolean;
      dateStored?: boolean;
      options?: Record<string, unknown>;
    }) => {
      const members: { keywordTypeId: string; sequenceNum: number }[] = [];
      for (const entry of args.keywordTypes) {
        const id = await resolveAdminRef(
          context,
          auth,
          'keyword-types',
          entry.keywordType,
          'keyword type'
        );
        if (typeof id !== 'string') return errText(id.refusal);
        members.push({ keywordTypeId: id, sequenceNum: entry.sequenceNum });
      }
      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        ...(args.multiInstanceKeywordTypeGroup !== undefined
          ? { multiInstanceKeywordTypeGroup: args.multiInstanceKeywordTypeGroup }
          : {}),
        ...(args.nullAllowed !== undefined ? { nullAllowed: args.nullAllowed } : {}),
        ...(args.dateStored !== undefined ? { dateStored: args.dateStored } : {}),
        // keywordTypeGroupId is circular at creation time (the group doesn't
        // exist yet); '0' follows this API's own "0 = ungrouped/unset"
        // convention elsewhere and is expected to be filled in by the server.
        keywordTypes: members.map((m) => ({ ...m, keywordTypeGroupId: '0' })),
      };
      const created = await apiJson(
        auth,
        { method: 'POST', path: '/api/keyword-type-groups', body },
        'create the keyword type group'
      );
      if (typeof created === 'string') return errText(created);
      invalidateAdminCatalog(context, 'keyword-type-groups');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(
        `Created keyword type group "${args.name}"${newId ? ` (id ${newId})` : ''} with ` +
          `${members.length} keyword type(s).`
      );
    }
  );

  server.registerTool(
    'onbase_admin_create_file_type',
    {
      title: 'OnBase Admin · Act — Create a file type',
      description:
        'Create a new file type. displayType is required (onbase_admin_list_display_types shows ' +
        'valid values, e.g. "Pdf", "Text", "Image") — it is a plain name, not an id reference.',
      inputSchema: z.object({
        name: z.string().min(1),
        displayType: z.string().min(1),
        extension: z.string().optional().describe('e.g. "pdf"; "???" (the default) means none.'),
        options: optionsSchema,
      }),
    },
    async (args: {
      name: string;
      displayType: string;
      extension?: string;
      options?: Record<string, unknown>;
    }) => {
      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        displayType: args.displayType,
        ...(args.extension !== undefined ? { extension: args.extension } : {}),
      };
      const created = await apiJson(
        auth,
        { method: 'POST', path: '/api/file-types', body },
        'create the file type'
      );
      if (typeof created === 'string') return errText(created);
      invalidateAdminCatalog(context, 'file-types');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(`Created file type "${args.name}"${newId ? ` (id ${newId})` : ''}.`);
    }
  );

  server.registerTool(
    'onbase_admin_assign_keyword_types',
    {
      title: 'OnBase Admin · Act — Assign keyword types to a document type',
      description:
        'Change which keyword types a document type has — the actual mechanism behind adding a ' +
        "keyword to a document type. OnBase's own API REPLACES every assignment on every write; " +
        'this tool protects against that by reading the current assignments, merging your changes ' +
        'in by keyword type (unnamed assignments are preserved), and writing the whole collection ' +
        'back. Set remove: true on an entry to drop that keyword type from the document type ' +
        'instead of adding or changing it.',
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
        assignments: z
          .array(
            z.object({
              keywordType: z.string().min(1).describe('Keyword type name or id.'),
              remove: z
                .boolean()
                .optional()
                .describe('Drop this keyword type instead of setting it.'),
              required: z.boolean().optional(),
              sequenceNum: z.number().int().min(0).optional(),
              defaultKeywordValue: z.string().optional(),
              keywordTypeGroup: z
                .string()
                .optional()
                .describe('Keyword type group name or id, if grouped.'),
              hidden: z.boolean().optional(),
              readOnly: z.boolean().optional(),
              makesDocUnique: z.boolean().optional(),
              requiredForRetrieval: z.boolean().optional(),
            })
          )
          .min(1),
      }),
    },
    async (args: {
      documentType: string;
      assignments: {
        keywordType: string;
        remove?: boolean;
        required?: boolean;
        sequenceNum?: number;
        defaultKeywordValue?: string;
        keywordTypeGroup?: string;
        hidden?: boolean;
        readOnly?: boolean;
        makesDocUnique?: boolean;
        requiredForRetrieval?: boolean;
      }[];
    }) => {
      const documentTypeId = await resolveAdminRef(
        context,
        auth,
        'document-types',
        args.documentType,
        'document type'
      );
      if (typeof documentTypeId !== 'string') return errText(documentTypeId.refusal);

      const current = await apiJson(
        auth,
        { method: 'GET', path: '/api/document-types/keyword-types', query: { documentTypeId } },
        'read the current keyword assignments'
      );
      if (typeof current === 'string') return errText(current);
      const byType = new Map<string, Record<string, unknown>>();
      if (isRecord(current.json) && Array.isArray(current.json.items)) {
        for (const item of current.json.items) {
          if (isRecord(item) && typeof item.keywordTypeId === 'string') {
            byType.set(item.keywordTypeId, item);
          }
        }
      }

      let added = 0;
      let changed = 0;
      let removed = 0;
      for (const assignment of args.assignments) {
        const keywordTypeId = await resolveAdminRef(
          context,
          auth,
          'keyword-types',
          assignment.keywordType,
          'keyword type'
        );
        if (typeof keywordTypeId !== 'string') return errText(keywordTypeId.refusal);

        if (assignment.remove) {
          if (byType.delete(keywordTypeId)) removed += 1;
          continue;
        }

        let keywordTypeGroupId: string | undefined;
        if (assignment.keywordTypeGroup) {
          const resolved = await resolveAdminRef(
            context,
            auth,
            'keyword-type-groups',
            assignment.keywordTypeGroup,
            'keyword type group'
          );
          if (typeof resolved !== 'string') return errText(resolved.refusal);
          keywordTypeGroupId = resolved;
        }

        const existing = byType.get(keywordTypeId);
        if (existing) changed += 1;
        else added += 1;
        byType.set(keywordTypeId, {
          ...existing,
          keywordTypeId,
          documentTypeId,
          ...(keywordTypeGroupId !== undefined ? { keywordTypeGroupId } : {}),
          ...(assignment.required !== undefined ? { required: assignment.required } : {}),
          ...(assignment.sequenceNum !== undefined ? { sequenceNum: assignment.sequenceNum } : {}),
          ...(assignment.defaultKeywordValue !== undefined
            ? { defaultKeywordValue: assignment.defaultKeywordValue }
            : {}),
          ...(assignment.hidden !== undefined ? { hidden: assignment.hidden } : {}),
          ...(assignment.readOnly !== undefined ? { readOnly: assignment.readOnly } : {}),
          ...(assignment.makesDocUnique !== undefined
            ? { makesDocUnique: assignment.makesDocUnique }
            : {}),
          ...(assignment.requiredForRetrieval !== undefined
            ? { requiredForRetrieval: assignment.requiredForRetrieval }
            : {}),
        });
      }

      const written = await apiJson(
        auth,
        {
          method: 'PUT',
          path: `/api/document-types/${encodeURIComponent(documentTypeId)}/keyword-types`,
          body: [...byType.values()],
        },
        'write the keyword assignments'
      );
      if (typeof written === 'string') return errText(written);
      return textResult(
        `Document type ${args.documentType}: ${added} keyword type(s) added, ${changed} changed, ` +
          `${removed} removed. ${byType.size} keyword type(s) assigned in total.`
      );
    }
  );
  server.registerTool(
    'onbase_admin_assign_document_type_user_groups',
    {
      title: 'OnBase Admin · Act — Grant a document type to user groups',
      description:
        'Change which user groups may see a document type — the mechanism that makes a ' +
        "document type appear in OnBase Configuration and in the clients. OnBase's own API " +
        'REPLACES every grant on every write; this tool reads the current grants, merges your ' +
        'changes in (unnamed groups keep their grant), and writes the whole set back. Set ' +
        'remove: true on an entry to revoke that group instead of granting it.',
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
        userGroups: z
          .array(
            z.object({
              userGroup: z.string().min(1).describe('User group name or id.'),
              remove: z.boolean().optional().describe('Revoke this group instead of granting it.'),
            })
          )
          .min(1),
      }),
    },
    async (args: {
      documentType: string;
      userGroups: { userGroup: string; remove?: boolean }[];
    }) => {
      const documentTypeId = await resolveAdminRef(
        context,
        auth,
        'document-types',
        args.documentType,
        'document type'
      );
      if (typeof documentTypeId !== 'string') return errText(documentTypeId.refusal);
      const current = await documentTypeUserGroups(auth, documentTypeId);
      if (typeof current === 'string') return errText(current);

      const merged = await mergeUserGroupGrants(context, auth, current, args.userGroups);
      if (!('ids' in merged)) return errText(merged.refusal);

      const written = await apiJson(
        auth,
        {
          method: 'PUT',
          path: '/api/document-types/user-groups',
          query: { documentTypeId },
          body: merged.ids.map((userGroupId) => ({ userGroupId, documentTypeId })),
        },
        'write the document type grants'
      );
      if (typeof written === 'string') return errText(written);
      const groupNames = await adminNames(context, auth, 'user-groups');
      return textResult(
        `Document type ${args.documentType}: ${merged.added} user group(s) granted, ` +
          `${merged.removed} revoked. ` +
          (merged.ids.length === 0
            ? 'No user group may see it now — it is invisible everywhere until one is granted.'
            : `Granted to ${merged.ids.length}: ` +
              merged.ids.map((g) => labelled(groupNames, g, 'user group')).join(', ') +
              '.')
      );
    }
  );

  server.registerTool(
    'onbase_admin_assign_document_type_group_user_groups',
    {
      title: 'OnBase Admin · Act — Grant a document type group to user groups',
      description:
        'Change which user groups may see a document type group. Same read-merge-write ' +
        'protection as onbase_admin_assign_document_type_user_groups: unnamed groups keep ' +
        'their grant; remove: true revokes one. Granting the group does not by itself grant ' +
        'the document types inside it — grant those individually.',
      inputSchema: z.object({
        documentTypeGroup: z.string().min(1).describe('Document type group name or id.'),
        userGroups: z
          .array(
            z.object({
              userGroup: z.string().min(1).describe('User group name or id.'),
              remove: z.boolean().optional().describe('Revoke this group instead of granting it.'),
            })
          )
          .min(1),
      }),
    },
    async (args: {
      documentTypeGroup: string;
      userGroups: { userGroup: string; remove?: boolean }[];
    }) => {
      const documentTypeGroupId = await resolveAdminRef(
        context,
        auth,
        'document-type-groups',
        args.documentTypeGroup,
        'document type group'
      );
      if (typeof documentTypeGroupId !== 'string') return errText(documentTypeGroupId.refusal);
      const current = await documentTypeGroupUserGroups(auth, documentTypeGroupId);
      if (typeof current === 'string') return errText(current);

      const merged = await mergeUserGroupGrants(context, auth, current, args.userGroups);
      if (!('ids' in merged)) return errText(merged.refusal);

      const written = await apiJson(
        auth,
        {
          method: 'PUT',
          path: `/api/document-type-groups/${encodeURIComponent(documentTypeGroupId)}/user-groups`,
          // This endpoint takes the collection object, not a bare array —
          // unlike its document-type twin.
          body: { items: merged.ids.map((userGroupId) => ({ userGroupId, documentTypeGroupId })) },
        },
        'write the document type group grants'
      );
      if (typeof written === 'string') return errText(written);
      const groupNames = await adminNames(context, auth, 'user-groups');
      return textResult(
        `Document type group ${args.documentTypeGroup}: ${merged.added} user group(s) granted, ` +
          `${merged.removed} revoked. ` +
          (merged.ids.length === 0
            ? 'No user group may see it now.'
            : `Granted to ${merged.ids.length}: ` +
              merged.ids.map((g) => labelled(groupNames, g, 'user group')).join(', ') +
              '.')
      );
    }
  );
}

/** The user group ids currently granted a document type. */
async function documentTypeUserGroups(
  auth: OnBaseAuth,
  documentTypeId: string
): Promise<string[] | string> {
  const result = await apiJson(
    auth,
    { method: 'GET', path: '/api/document-types/user-groups', query: { documentTypeId } },
    "read the document type's user groups"
  );
  if (typeof result === 'string') return result;
  return assignmentItems(result.json)
    .map((a) => str(a.userGroupId))
    .filter((id) => id !== '');
}

/** The user group ids currently granted a document type group. */
async function documentTypeGroupUserGroups(
  auth: OnBaseAuth,
  documentTypeGroupId: string
): Promise<string[] | string> {
  const result = await apiJson(
    auth,
    {
      method: 'GET',
      path: '/api/document-type-groups/user-groups',
      query: { documentTypeGroupId },
    },
    "read the document type group's user groups"
  );
  if (typeof result === 'string') return result;
  return assignmentItems(result.json)
    .map((a) => str(a.userGroupId))
    .filter((id) => id !== '');
}

/**
 * Apply grant/revoke entries (user groups by name or id) to the current set
 * of granted user group ids — the merge half of read-merge-write, shared by
 * the document type and document type group grant tools.
 */
async function mergeUserGroupGrants(
  context: MCPToolContext,
  auth: OnBaseAuth,
  current: readonly string[],
  changes: readonly { userGroup: string; remove?: boolean }[]
): Promise<{ ids: string[]; added: number; removed: number } | { refusal: string }> {
  const ids = [...current];
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const id = await resolveAdminRef(context, auth, 'user-groups', change.userGroup, 'user group');
    if (typeof id !== 'string') return id;
    const at = ids.indexOf(id);
    if (change.remove) {
      if (at !== -1) {
        ids.splice(at, 1);
        removed += 1;
      }
    } else if (at === -1) {
      ids.push(id);
      added += 1;
    }
  }
  return { ids, added, removed };
}

/** Shared by onbase_admin_get_document_type_keywords's own rendering. */
async function renderAssignments(
  context: MCPToolContext,
  auth: OnBaseAuth,
  documentTypeId: string
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const result = await apiJson(
    auth,
    { method: 'GET', path: '/api/document-types/keyword-types', query: { documentTypeId } },
    'read the keyword assignments'
  );
  if (typeof result === 'string') return { ok: false, text: result };
  const items = isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
  if (items.length === 0) {
    return { ok: true, text: 'No keyword types are assigned to this document type.' };
  }

  const catalog = await loadAdminCatalog(context, auth, 'keyword-types');
  const names = new Map(
    typeof catalog === 'string' ? [] : catalog.map((t) => [t.id, displayName(t)])
  );

  const lines = items.filter(isRecord).map((item) => {
    const label = names.get(str(item.keywordTypeId)) ?? `keyword type ${str(item.keywordTypeId)}`;
    const flags = [
      item.required === true ? 'required' : null,
      item.hidden === true ? 'hidden' : null,
      item.readOnly === true ? 'read-only' : null,
      item.makesDocUnique === true ? 'makes-unique' : null,
    ].filter((f): f is string => f !== null);
    return `  ${label} (id ${str(item.keywordTypeId)})${flags.length ? ` [${flags.join(', ')}]` : ''}`;
  });
  return { ok: true, text: `Assigned keyword types:\n${lines.join('\n')}` };
}
