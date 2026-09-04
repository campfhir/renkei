/**
 * The onbase_admin_* tools — OnBase's *Administration* API (Foundation
 * 26.1, docs/onbase-administration-openapi-spec.json), a different product
 * from the Document API `index.ts` wraps: it configures OnBase rather than
 * filing documents into it — document types, keyword types, the keyword
 * types assigned to a document type, document/keyword type groups, file
 * types, and the change-control audit log.
 *
 * Three things carry over from the Document API tools, because the shape
 * of the problem is the same:
 *
 *   - Names resolve to ids INSIDE the tools. Where a reference is something
 *     the Document API already lists (document types, keyword types,
 *     document/keyword type groups, file types), resolution reuses
 *     index.ts's existing resolveRef/loadCatalog — same ids, same cache,
 *     one implementation — so the admin tools do not require the
 *     Administration API base URL just to resolve a name.
 *   - `PUT /api/document-types/{id}/keyword-types` REPLACES every keyword
 *     assignment on the document type, and reports success either way.
 *     onbase_admin_assign_keyword_types therefore reads the current
 *     assignments, merges the caller's changes in by keyword type id, and
 *     writes the whole collection back — the same trap, the same fix, as
 *     onbase_update_keywords in index.ts.
 *   - A create or rename invalidates the shared name→id cache for that
 *     catalog kind, so a document type created this turn resolves by name
 *     on the very next tool call instead of waiting out five minutes of
 *     staleness.
 *
 * Reachability is separate from the Document API: the Administration API
 * lives at a tenant-configured `adminApiBaseUrl` (sibling to `apiBaseUrl`,
 * `{server}/onbase/administration` vs `{server}/onbase/core`), optional
 * because a tenant that connects OnBase for document retrieval need not
 * also grant configuration access. `auth.adminApi` answers a plain refusal
 * string when it is unset — every tool here surfaces that the same way it
 * surfaces any other refusal.
 *
 * Deliberately not in this cut, matching the Document API tools' own
 * "nothing destructive, nothing identity/security-adjacent in v1" scope:
 * no deletes anywhere (a document type or keyword type deleted on a
 * model's say-so is not a v1 capability); no users or user groups
 * (creating accounts and editing rights is identity management, a
 * different risk class from document configuration); no password
 * policies, EVM, Insight Discovery, key providers, or security keywords
 * (unrelated to "document types and keywords", and each wants its own
 * considered story); disk groups and file types are read-only reference
 * data here (an admin creates storage infrastructure and viewer file
 * types deliberately, not as a side effect of filing documents); no PATCH
 * update for document type groups or file types (only document types and
 * keyword types, the two things this cut is actually for).
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
  invalidateCatalog,
  isRecord,
  loadCatalog,
  namedList,
  resolveRef,
  str,
  textResult,
  type NamedThing,
} from './index';

/** One Administration API call, reusing index.ts's envelope/error handling. */
function adminApiJson(
  auth: OnBaseAuth,
  request: Parameters<OnBaseAuth['api']>[0],
  what: string
): ReturnType<typeof apiJson> {
  return apiJson({ api: auth.adminApi }, request, what);
}

/** Disk groups and display types: Administration-only reference vocabulary. */
const adminCatalogCache = new CatalogCache<NamedThing[]>();

async function loadDiskGroups(
  context: MCPToolContext,
  auth: OnBaseAuth
): Promise<NamedThing[] | string> {
  const cacheKey = `${context.tenantId}:admin-disk-groups`;
  const cached = adminCatalogCache.get(cacheKey);
  if (cached) return cached;
  const result = await adminApiJson(auth, { method: 'GET', path: '/api/disk-groups' }, 'list disk groups');
  if (typeof result === 'string') return result;
  const items = namedList(result.json);
  adminCatalogCache.set(cacheKey, items);
  return items;
}

async function resolveDiskGroupRef(
  context: MCPToolContext,
  auth: OnBaseAuth,
  ref: string
): Promise<string | { refusal: string }> {
  const catalog = await loadDiskGroups(context, auth);
  if (typeof catalog === 'string') return { refusal: catalog };
  const resolved = resolveKeywordTypeRef(catalog, ref, 'disk group');
  if (!resolved.ok) return { refusal: resolved.err.message ?? `Unknown disk group: ${ref}` };
  return resolved.val;
}

/** JSON Patch from a flat field-name → new-value object; every op is "replace". */
function replacePatch(fields: Record<string, unknown>): { op: 'replace'; path: string; value: unknown }[] {
  return Object.entries(fields).map(([key, value]) => ({ op: 'replace' as const, path: `/${key}`, value }));
}

const optionsSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Any other field from the OnBase Administration API schema, passed through verbatim ' +
      '(docs/onbase-administration-openapi-spec.json). Named parameters above always win over ' +
      'a same-named entry here.'
  );

export function registerOnbaseAdminTools(
  server: McpServer,
  context: MCPToolContext,
  auth: OnBaseAuth
): void {
  /* ------------------------------- Read ------------------------------- */

  server.registerTool(
    'onbase_admin_get_document_type',
    {
      title: 'OnBase Admin · Read — Document type configuration',
      description:
        'The full configuration of one document type — every field the Administration API ' +
        'exposes (disk group, default file format, retrieval/display behavior), not just the ' +
        'name and id onbase_list_document_types shows. Use before onbase_admin_update_document_type ' +
        'to see current values.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
      }),
    },
    async (args: { documentType: string }) => {
      const id = await resolveRef(context, auth, 'document-types', args.documentType, 'document type');
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await adminApiJson(
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
        'settings — not just the name and id onbase_list_keyword_types shows. Use before ' +
        'onbase_admin_update_keyword_type to see current values.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        keywordType: z.string().min(1).describe('Keyword type name or id.'),
      }),
    },
    async (args: { keywordType: string }) => {
      const id = await resolveRef(context, auth, 'keyword-types', args.keywordType, 'keyword type');
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await adminApiJson(
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
      const id = await resolveRef(
        context,
        auth,
        'document-type-groups',
        args.documentTypeGroup,
        'document type group'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await adminApiJson(
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
      const id = await resolveRef(
        context,
        auth,
        'keyword-type-groups',
        args.keywordTypeGroup,
        'keyword type group'
      );
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await adminApiJson(
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
      description: 'The full configuration of one file type (display type, extension, viewer options).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        fileType: z.string().min(1).describe('File type name or id.'),
      }),
    },
    async (args: { fileType: string }) => {
      const id = await resolveRef(context, auth, 'file-types', args.fileType, 'file type');
      if (typeof id !== 'string') return errText(id.refusal);
      const result = await adminApiJson(
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
        'onbase_admin_create_document_type\'s defaultFileFormat and onbase_admin_create_file_type ' +
        'resolve names against.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const types = await loadCatalog(context, auth, 'file-types');
      if (typeof types === 'string') return errText(types);
      if (types.length === 0) return textResult('No file types are visible to your account.');
      return textResult(
        'File types (name — id):\n' + types.map((t) => `  ${displayName(t)} — id ${t.id}`).join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_admin_list_disk_groups',
    {
      title: 'OnBase Admin · Read — List disk groups',
      description:
        'The disk groups configured in this OnBase, by name and id — required to create a ' +
        "document type (its defaultDiskGroup). Disk groups themselves are not created here: " +
        "they're storage infrastructure an OnBase admin sets up deliberately, not a byproduct " +
        'of configuring document types.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const groups = await loadDiskGroups(context, auth);
      if (typeof groups === 'string') return errText(groups);
      if (groups.length === 0) return textResult('No disk groups are visible to your account.');
      return textResult(
        'Disk groups (name — id):\n' + groups.map((g) => `  ${displayName(g)} — id ${g.id}`).join('\n')
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
      const result = await adminApiJson(
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
      const id = await resolveRef(context, auth, 'document-types', args.documentType, 'document type');
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
      const result = await adminApiJson(
        auth,
        { method: 'GET', path: '/api/change-events', query },
        'list change events'
      );
      if (typeof result === 'string') return errText(result);
      const items = isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
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

  /* ------------------------------- Act -------------------------------- */

  server.registerTool(
    'onbase_admin_create_document_type',
    {
      title: 'OnBase Admin · Act — Create a document type',
      description:
        'Create a new document type. documentTypeGroup, defaultFileFormat and defaultDiskGroup ' +
        'are required by OnBase and are resolved from names (onbase_list_document_types, ' +
        'onbase_admin_list_file_types, onbase_admin_list_disk_groups show the vocabulary). ' +
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
        userGroupIds: z
          .array(z.string())
          .optional()
          .describe('User groups to grant this document type to immediately, by id.'),
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
      userGroupIds?: string[];
      options?: Record<string, unknown>;
    }) => {
      const groupId = await resolveRef(
        context,
        auth,
        'document-type-groups',
        args.documentTypeGroup,
        'document type group'
      );
      if (typeof groupId !== 'string') return errText(groupId.refusal);
      const fileFormatId = await resolveRef(
        context,
        auth,
        'file-types',
        args.defaultFileFormat,
        'file type'
      );
      if (typeof fileFormatId !== 'string') return errText(fileFormatId.refusal);
      const diskGroupId = await resolveDiskGroupRef(context, auth, args.defaultDiskGroup);
      if (typeof diskGroupId !== 'string') return errText(diskGroupId.refusal);

      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        documentTypeGroupId: groupId,
        defaultFileFormatId: fileFormatId,
        defaultDiskGroupId: diskGroupId,
        ...(args.autoNameString !== undefined ? { autoNameString: args.autoNameString } : {}),
        ...(args.allowMarkUp !== undefined ? { allowMarkUp: args.allowMarkUp } : {}),
        ...(args.cachingAllowed !== undefined ? { cachingAllowed: args.cachingAllowed } : {}),
        ...(args.thumbnailsEnabled !== undefined ? { thumbnailsEnabled: args.thumbnailsEnabled } : {}),
        ...(args.retrievalListSortOrder ? { retrievalListSortOrder: args.retrievalListSortOrder } : {}),
        ...(args.userGroupIds ? { userGroupIds: args.userGroupIds.map((id) => Number(id)) } : {}),
      };

      const created = await adminApiJson(
        auth,
        { method: 'POST', path: '/api/document-types', body },
        'create the document type'
      );
      if (typeof created === 'string') return errText(created);
      invalidateCatalog(context, 'document-types');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(
        `Created document type "${args.name}"${newId ? ` (id ${newId})` : ''}. Use ` +
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
        '(each is a top-level property from onbase_admin_get_document_type\'s output, e.g. ' +
        '{"cachingAllowed": true, "autoNameString": "%N - %D2"}) — everything else is left as is.',
      inputSchema: z.object({
        documentType: z.string().min(1).describe('Document type name or id.'),
        fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
          message: 'fields must name at least one property to change.',
        }),
      }),
    },
    async (args: { documentType: string; fields: Record<string, unknown> }) => {
      const id = await resolveRef(context, auth, 'document-types', args.documentType, 'document type');
      if (typeof id !== 'string') return errText(id.refusal);
      const updated = await adminApiJson(
        auth,
        {
          method: 'PATCH',
          path: `/api/document-types/${encodeURIComponent(id)}`,
          body: replacePatch(args.fields),
        },
        'update the document type'
      );
      if (typeof updated === 'string') return errText(updated);
      if (args.fields.name !== undefined) invalidateCatalog(context, 'document-types');
      return textResult(
        `Updated document type ${args.documentType}: ${Object.keys(args.fields).join(', ')}.`
      );
    }
  );

  server.registerTool(
    'onbase_admin_create_keyword_type',
    {
      title: 'OnBase Admin · Act — Create a keyword type',
      description: 'Create a new keyword type. dataType is required by OnBase and cannot change later.',
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
      const created = await adminApiJson(
        auth,
        { method: 'POST', path: '/api/keyword-types', body },
        'create the keyword type'
      );
      if (typeof created === 'string') return errText(created);
      invalidateCatalog(context, 'keyword-types');
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
        '(top-level properties from onbase_admin_get_keyword_type\'s output) — everything else ' +
        'is left as is. dataType cannot be changed once documents use this keyword type.',
      inputSchema: z.object({
        keywordType: z.string().min(1).describe('Keyword type name or id.'),
        fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
          message: 'fields must name at least one property to change.',
        }),
      }),
    },
    async (args: { keywordType: string; fields: Record<string, unknown> }) => {
      const id = await resolveRef(context, auth, 'keyword-types', args.keywordType, 'keyword type');
      if (typeof id !== 'string') return errText(id.refusal);
      const updated = await adminApiJson(
        auth,
        {
          method: 'PATCH',
          path: `/api/keyword-types/${encodeURIComponent(id)}`,
          body: replacePatch(args.fields),
        },
        'update the keyword type'
      );
      if (typeof updated === 'string') return errText(updated);
      if (args.fields.name !== undefined) invalidateCatalog(context, 'keyword-types');
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
        userGroupIds: z
          .array(z.string())
          .optional()
          .describe('User groups to grant this document type group to immediately, by id.'),
        options: optionsSchema,
      }),
    },
    async (args: {
      name: string;
      documentSource?: string;
      userGroupIds?: string[];
      options?: Record<string, unknown>;
    }) => {
      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        ...(args.documentSource ? { documentSource: args.documentSource } : {}),
        ...(args.userGroupIds ? { userGroupIds: args.userGroupIds.map((id) => Number(id)) } : {}),
      };
      const created = await adminApiJson(
        auth,
        { method: 'POST', path: '/api/document-type-groups', body },
        'create the document type group'
      );
      if (typeof created === 'string') return errText(created);
      invalidateCatalog(context, 'document-type-groups');
      const newId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(`Created document type group "${args.name}"${newId ? ` (id ${newId})` : ''}.`);
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
        const id = await resolveRef(context, auth, 'keyword-types', entry.keywordType, 'keyword type');
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
      const created = await adminApiJson(
        auth,
        { method: 'POST', path: '/api/keyword-type-groups', body },
        'create the keyword type group'
      );
      if (typeof created === 'string') return errText(created);
      invalidateCatalog(context, 'keyword-type-groups');
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
    async (args: { name: string; displayType: string; extension?: string; options?: Record<string, unknown> }) => {
      const body: Record<string, unknown> = {
        ...args.options,
        name: args.name,
        displayType: args.displayType,
        ...(args.extension !== undefined ? { extension: args.extension } : {}),
      };
      const created = await adminApiJson(
        auth,
        { method: 'POST', path: '/api/file-types', body },
        'create the file type'
      );
      if (typeof created === 'string') return errText(created);
      invalidateCatalog(context, 'file-types');
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
              remove: z.boolean().optional().describe('Drop this keyword type instead of setting it.'),
              required: z.boolean().optional(),
              sequenceNum: z.number().int().min(0).optional(),
              defaultKeywordValue: z.string().optional(),
              keywordTypeGroup: z.string().optional().describe('Keyword type group name or id, if grouped.'),
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
      const documentTypeId = await resolveRef(
        context,
        auth,
        'document-types',
        args.documentType,
        'document type'
      );
      if (typeof documentTypeId !== 'string') return errText(documentTypeId.refusal);

      const current = await adminApiJson(
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
        const keywordTypeId = await resolveRef(
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
          const resolved = await resolveRef(
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
          ...(assignment.makesDocUnique !== undefined ? { makesDocUnique: assignment.makesDocUnique } : {}),
          ...(assignment.requiredForRetrieval !== undefined
            ? { requiredForRetrieval: assignment.requiredForRetrieval }
            : {}),
        });
      }

      const written = await adminApiJson(
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
}

/** Shared by onbase_admin_get_document_type_keywords's own rendering. */
async function renderAssignments(
  context: MCPToolContext,
  auth: OnBaseAuth,
  documentTypeId: string
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const result = await adminApiJson(
    auth,
    { method: 'GET', path: '/api/document-types/keyword-types', query: { documentTypeId } },
    'read the keyword assignments'
  );
  if (typeof result === 'string') return { ok: false, text: result };
  const items = isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
  if (items.length === 0) {
    return { ok: true, text: 'No keyword types are assigned to this document type.' };
  }

  const catalog = await loadCatalog(context, auth, 'keyword-types');
  const names = new Map(typeof catalog === 'string' ? [] : catalog.map((t) => [t.id, displayName(t)]));

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
