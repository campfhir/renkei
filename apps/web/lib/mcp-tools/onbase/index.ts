/**
 * The onbase_* tools — the customer's own Hyland OnBase document store,
 * reached exclusively through the OnBase egress worker (the API server
 * lives on the customer's network; see lib/onbase/service-client.ts).
 *
 * The shape of the API drives the shape of the tools:
 *
 *   - There is no free-text search. A query names its scope (document
 *     type, type group, or a saved custom query) and constrains KEYWORD
 *     values by numeric type id. The tools resolve the names a model holds
 *     ("Vendor", "Invoice Amount") to ids from the tenant's own vocabulary
 *     (cached ~5 minutes), so the caller never runs a lookup errand first.
 *   - `PUT /documents/{id}/keywords` REPLACES every keyword value on the
 *     document, and reports success either way. onbase_update_keywords
 *     therefore reads the current collection, merges, and writes the whole
 *     thing back — stated in its description so the model knows the
 *     semantics it is getting.
 *   - Uploads are three steps (stage, bytes, archive). The bytes ride the
 *     repo's upload-slot path — never a base64 tool argument — and the
 *     archive step completes from the slot's recorded staging reference.
 *   - Encrypted ("sensitive") note text is NEVER fetched: the API keeps it
 *     behind a separate endpoint on purpose, and this connector treats
 *     that as the author's intent.
 *
 * No scope gate: the IdP exposes one opaque Document Management scope, so
 * the availability probe (a grant row exists) plus the capability gate is
 * the whole story. Authorization inside OnBase — which document types and
 * documents this user may see — is OnBase's own, enforced by the API
 * server per request under the user's token (RENKEI.md Decision #2).
 *
 * Creating or configuring document types and keyword types is a SEPARATE
 * connector, `onbase-admin` (`./admin-tools.ts`) — a different Hyland OAuth
 * client against a different product (the Administration API), connected
 * and revoked independently of this one. Nothing here reaches it, and
 * nothing there reaches this.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { extractText, DEFAULT_MAX_INPUT_BYTES } from '@renkei/document-text';
import {
  buildQueryInformation,
  CatalogCache,
  flattenKeywordValues,
  mergeKeywordCollections,
  resolveKeywordTypeRef,
  type KeywordUpdate,
  type OnBaseKeywordCollection,
  type OnBaseQueryKeyword,
  type QueryTargetKind,
} from '@renkei/connector-onbase';
import { getDatabase } from '@renkei/db';
import type { MCPToolContext } from '../common';
import { createUploadSlot } from '../upload-slots';
import type { OnBaseAuth } from './onbase-auth';

/** The connector key the OnBase capabilities register under. */
export const ONBASE_MCP_CONNECTOR = 'onbase';

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A documentId (or any other API-path segment) safe to place in a path. */
export function idSegment(value: unknown): string | null {
  const id = str(value).trim();
  if (!id || /[/?#\s]/.test(id)) return null;
  return encodeURIComponent(id);
}

/**
 * One Document API call through the injected auth, answering parsed JSON
 * (null for 204) or a user-visible refusal. Non-2xx statuses become prose
 * carrying the server's problem+json detail — OnBase's own words beat a
 * generic failure.
 */
export async function apiJson(
  // Structural, not OnBaseAuth itself, so the admin tools can pass
  // `{ api: auth.adminApi }` and reuse this exact envelope/error handling
  // against the Administration API instead of the Document API.
  caller: Pick<OnBaseAuth, 'api'>,
  request: Parameters<OnBaseAuth['api']>[0],
  what: string
): Promise<{ status: number; json: unknown } | string> {
  const response = await caller.api(request);
  if (typeof response === 'string') return response;
  let json: unknown = null;
  if (response.body) {
    try {
      json = JSON.parse(response.body);
    } catch {
      json = null;
    }
  }
  if (response.status >= 200 && response.status < 300) return { status: response.status, json };
  // 300 is a real answer for archive/reindex (matched existing documents);
  // hand it back for the caller to interpret rather than flattening it.
  if (response.status === 300) return { status: 300, json };
  const detail =
    (isRecord(json) && (str(json.detail) || str(json.title))) ||
    (response.status === 401
      ? 'the API server did not accept your session'
      : response.status === 403
        ? 'your OnBase account does not have rights for this'
        : response.status === 404
          ? 'no such resource'
          : '');
  return `Could not ${what}: OnBase answered ${response.status}${detail ? ` — ${detail}` : ''}.`;
}

export interface NamedThing {
  id: string;
  name?: string;
  systemName?: string;
}

export function namedList(
  value: unknown,
  extra?: (item: Record<string, unknown>) => NamedThing
): NamedThing[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  const out: NamedThing[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const base = extra ? extra(item) : { id: item.id };
    out.push({
      ...base,
      id: item.id,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.systemName === 'string' ? { systemName: item.systemName } : {}),
    });
  }
  return out;
}

export function displayName(thing: NamedThing): string {
  return thing.name ?? thing.systemName ?? '(unnamed)';
}

/**
 * Vocabulary cache, per tenant per kind. Five minutes of staleness on
 * admin-curated configuration is a fine trade against a catalog fetch on
 * every search. Only successes are cached (the CatalogCache contract).
 */
const catalogCache = new CatalogCache<NamedThing[]>();

export async function loadCatalog(
  context: MCPToolContext,
  auth: OnBaseAuth,
  kind: 'keyword-types' | 'document-types' | 'document-type-groups' | 'custom-queries' | 'note-types'
): Promise<NamedThing[] | string> {
  const cacheKey = `${context.tenantId}:${kind}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;
  const result = await apiJson(auth, { method: 'GET', path: `/${kind}` }, `list ${kind}`);
  if (typeof result === 'string') return result;
  const items = namedList(result.json);
  catalogCache.set(cacheKey, items);
  return items;
}

export async function resolveRef(
  context: MCPToolContext,
  auth: OnBaseAuth,
  kind: Parameters<typeof loadCatalog>[2],
  ref: string,
  noun: string
): Promise<string | { refusal: string }> {
  const catalog = await loadCatalog(context, auth, kind);
  if (typeof catalog === 'string') return { refusal: catalog };
  const resolved = resolveKeywordTypeRef(catalog, ref, noun);
  if (!resolved.ok) return { refusal: resolved.err.message ?? `Unknown ${noun}: ${ref}` };
  return resolved.val;
}

const OPERATORS = [
  'Equal',
  'LessThan',
  'GreaterThan',
  'LessThanEqual',
  'GreaterThanEqual',
  'NotEqual',
  'Literal',
] as const;
const RELATIONS = ['And', 'Or', 'To'] as const;

const keywordConstraintSchema = z.object({
  type: z.string().min(1).describe('Keyword type — a name (e.g. "Vendor") or its id.'),
  value: z.string().describe('The value to match, normalized (dates YYYY-MM-DD, plain numbers).'),
  operator: z.enum(OPERATORS).optional().describe('Default Equal. "To" ranges pair with relation.'),
  relation: z
    .enum(RELATIONS)
    .optional()
    .describe('How this constraint relates to the next one; default And.'),
});

const keywordValuesSchema = z.object({
  type: z.string().min(1).describe('Keyword type — a name or its id.'),
  values: z
    .array(z.string())
    .describe('The COMPLETE new value list for this keyword type; [] blanks it.'),
});

/** Resolve keyword-constraint names to typed query keywords. */
async function resolveConstraints(
  context: MCPToolContext,
  auth: OnBaseAuth,
  constraints: z.infer<typeof keywordConstraintSchema>[]
): Promise<OnBaseQueryKeyword[] | { refusal: string }> {
  const resolved: OnBaseQueryKeyword[] = [];
  for (const constraint of constraints) {
    const typeId = await resolveRef(context, auth, 'keyword-types', constraint.type, 'keyword type');
    if (typeof typeId !== 'string') return typeId;
    resolved.push({
      typeId,
      value: constraint.value,
      ...(constraint.operator ? { operator: constraint.operator } : {}),
      ...(constraint.relation ? { relation: constraint.relation } : {}),
    });
  }
  return resolved;
}

/** Two-step query execution: submit, then fetch results. */
async function runQuery(
  context: MCPToolContext,
  auth: OnBaseAuth,
  options: {
    targets: { kind: QueryTargetKind; ids: string[] }[];
    keywords?: OnBaseQueryKeyword[];
    documentDateRange?: { start?: string; end?: string };
    maxResults: number;
  }
): Promise<string> {
  const query = buildQueryInformation({
    ...options,
    // Predictable result columns whatever the server has preconfigured.
    displayColumns: [
      { displayColumnType: 'DocumentName' },
      { displayColumnType: 'DocumentTypeName' },
      { displayColumnType: 'DocumentDate' },
    ],
  });
  if (!query.ok) return 'The query needs a document type, a type group, or a custom query.';

  const submitted = await apiJson(
    auth,
    { method: 'POST', path: '/documents/queries', body: query.val },
    'submit the document query'
  );
  if (typeof submitted === 'string') return submitted;
  const queryId = isRecord(submitted.json) ? str(submitted.json.id) : '';
  if (!queryId) return 'OnBase accepted the query but returned no query handle.';

  const results = await apiJson(
    auth,
    { method: 'GET', path: `/documents/queries/${encodeURIComponent(queryId)}/results` },
    'fetch the query results'
  );
  if (typeof results === 'string') return results;
  const items = isRecord(results.json) && Array.isArray(results.json.items) ? results.json.items : [];
  if (items.length === 0) {
    return 'No documents matched. (OnBase only returns documents your account may see.)';
  }

  const lines: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const columns = Array.isArray(item.displayColumns) ? item.displayColumns : [];
    const values = columns
      .map((column) =>
        isRecord(column) && Array.isArray(column.values)
          ? column.values.filter((v): v is string => typeof v === 'string').join('; ')
          : ''
      )
      .filter(Boolean);
    lines.push(`id ${item.id}${values.length ? ` — ${values.join(' — ')}` : ''}`);
  }
  return (
    `${lines.length} document(s) (columns: name — document type — document date):\n` +
    lines.join('\n')
  );
}

export function registerOnbaseTools(
  server: McpServer,
  context: MCPToolContext,
  auth: OnBaseAuth
): void {
  server.registerTool(
    'onbase_search_documents',
    {
      title: 'OnBase · Read — Search documents by type and keywords',
      description:
        'Find OnBase documents. There is no free-text search: name a scope — a document type ' +
        '(or type group) — and optionally constrain keyword values. Keyword types and document ' +
        'types may be given by NAME (onbase_list_keyword_types / onbase_list_document_types ' +
        'show the vocabulary); this tool resolves names to ids itself. For a saved search use ' +
        'onbase_run_custom_query. Results carry document ids for the other onbase_* tools.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentType: z
          .string()
          .optional()
          .describe('Scope: a document type name or id (this OR documentTypeGroup is required).'),
        documentTypeGroup: z.string().optional().describe('Scope: a document type group name or id.'),
        keywords: z
          .array(keywordConstraintSchema)
          .optional()
          .describe('Keyword constraints, ANDed unless a relation says otherwise.'),
        documentDateStart: z.string().optional().describe('Document-date range start, YYYY-MM-DD.'),
        documentDateEnd: z.string().optional().describe('Document-date range end, YYYY-MM-DD.'),
        maxResults: z.number().int().positive().max(200).optional().describe('Default 25.'),
      }),
    },
    async (args: {
      documentType?: string;
      documentTypeGroup?: string;
      keywords?: z.infer<typeof keywordConstraintSchema>[];
      documentDateStart?: string;
      documentDateEnd?: string;
      maxResults?: number;
    }) => {
      const targets: { kind: QueryTargetKind; ids: string[] }[] = [];
      if (args.documentType) {
        const id = await resolveRef(context, auth, 'document-types', args.documentType, 'document type');
        if (typeof id !== 'string') return errText(id.refusal);
        targets.push({ kind: 'DocumentType', ids: [id] });
      }
      if (args.documentTypeGroup) {
        const id = await resolveRef(
          context,
          auth,
          'document-type-groups',
          args.documentTypeGroup,
          'document type group'
        );
        if (typeof id !== 'string') return errText(id.refusal);
        targets.push({ kind: 'DocumentTypeGroup', ids: [id] });
      }
      if (targets.length === 0) {
        return errText(
          'Give a documentType or a documentTypeGroup to search in — ' +
            'onbase_list_document_types shows what exists.'
        );
      }
      const keywords = args.keywords
        ? await resolveConstraints(context, auth, args.keywords)
        : undefined;
      if (keywords && !Array.isArray(keywords)) return errText(keywords.refusal);

      const rendered = await runQuery(context, auth, {
        targets,
        ...(keywords && keywords.length > 0 ? { keywords } : {}),
        documentDateRange: { start: args.documentDateStart, end: args.documentDateEnd },
        maxResults: args.maxResults ?? 25,
      });
      return rendered.startsWith('Could not') || rendered.startsWith('The query')
        ? errText(rendered)
        : textResult(rendered);
    }
  );

  server.registerTool(
    'onbase_run_custom_query',
    {
      title: 'OnBase · Read — Run a saved custom query',
      description:
        'Execute one of the custom queries configured in OnBase (onbase_list_custom_queries ' +
        'shows them, with instructions). A custom query encodes the right scope and filters ' +
        'already, so prefer it over hand-building a search when one fits. Extra keyword ' +
        'constraints (names resolved to ids) and a document-date range can narrow it further.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        customQuery: z.string().min(1).describe('The custom query name or id.'),
        keywords: z.array(keywordConstraintSchema).optional(),
        documentDateStart: z.string().optional().describe('YYYY-MM-DD'),
        documentDateEnd: z.string().optional().describe('YYYY-MM-DD'),
        maxResults: z.number().int().positive().max(200).optional().describe('Default 25.'),
      }),
    },
    async (args: {
      customQuery: string;
      keywords?: z.infer<typeof keywordConstraintSchema>[];
      documentDateStart?: string;
      documentDateEnd?: string;
      maxResults?: number;
    }) => {
      const id = await resolveRef(context, auth, 'custom-queries', args.customQuery, 'custom query');
      if (typeof id !== 'string') return errText(id.refusal);
      const keywords = args.keywords
        ? await resolveConstraints(context, auth, args.keywords)
        : undefined;
      if (keywords && !Array.isArray(keywords)) return errText(keywords.refusal);

      const rendered = await runQuery(context, auth, {
        targets: [{ kind: 'CustomQuery', ids: [id] }],
        ...(keywords && keywords.length > 0 ? { keywords } : {}),
        documentDateRange: { start: args.documentDateStart, end: args.documentDateEnd },
        maxResults: args.maxResults ?? 25,
      });
      return rendered.startsWith('Could not') ? errText(rendered) : textResult(rendered);
    }
  );

  server.registerTool(
    'onbase_get_document',
    {
      title: 'OnBase · Read — Document metadata and keywords',
      description:
        'One document: its name, type, dates, status, and every keyword value on it (keyword ' +
        'type ids resolved to names). For the content use onbase_read_document.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: z.string().min(1).describe('From a search or custom query result.'),
      }),
    },
    async (args: { documentId: string }) => {
      const id = idSegment(args.documentId);
      if (!id) return errText('That is not a usable document id.');

      const [meta, keywords] = await Promise.all([
        apiJson(auth, { method: 'GET', path: `/documents/${id}` }, 'read the document'),
        apiJson(auth, { method: 'GET', path: `/documents/${id}/keywords` }, 'read the keywords'),
      ]);
      if (typeof meta === 'string') return errText(meta);
      if (typeof keywords === 'string') return errText(keywords);
      const record = isRecord(meta.json) ? meta.json : {};

      const lines = [
        `Document ${str(record.id) || args.documentId}: ${str(record.name) || '(unnamed)'}`,
        `Type id: ${str(record.typeId) || '?'} · status: ${str(record.status) || '?'}`,
        `Document date: ${str(record.documentDate) || '?'} · stored: ${str(record.storedDate) || '?'}`,
      ];

      const collection = keywords.json;
      if (isRecord(collection) && Array.isArray(collection.items)) {
        const flattened = flattenKeywordValues({
          items: collection.items.filter(isRecord).map((group) => ({
            keywords: Array.isArray(group.keywords) ? group.keywords.filter(isRecord) : [],
          })),
        });
        if (flattened.length > 0) {
          const catalog = await loadCatalog(context, auth, 'keyword-types');
          const names = new Map(
            typeof catalog === 'string' ? [] : catalog.map((t) => [t.id, displayName(t)])
          );
          lines.push('Keywords:');
          for (const entry of flattened) {
            const label = names.get(entry.typeId) ?? `type ${entry.typeId}`;
            lines.push(`  ${label}: ${entry.values.length ? entry.values.join('; ') : '(blank)'}`);
          }
        } else {
          lines.push('Keywords: none.');
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'onbase_read_document',
    {
      title: 'OnBase · Read — Read a document as text',
      description:
        "Fetch the document's default rendition (latest revision) and return its text — " +
        'documents (pdf, docx, xlsx, pptx, html) go through text extraction. For the raw ' +
        'bytes use onbase_download_document instead.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: z.string().min(1),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Cap on returned characters (default 60000).'),
      }),
    },
    async (args: { documentId: string; maxChars?: number }) => {
      const id = idSegment(args.documentId);
      if (!id) return errText('That is not a usable document id.');

      const content = await auth.content(
        `/documents/${id}/revisions/latest/renditions/default/content`
      );
      if (typeof content === 'string') return errText(content);

      const maxBytes = Math.min(
        DEFAULT_MAX_INPUT_BYTES,
        context.maxAttachmentBytes ?? DEFAULT_MAX_INPUT_BYTES
      );
      if (content.bytes.byteLength > maxBytes) {
        return errText(
          `The document is ${content.bytes.byteLength} bytes — over this org's ${maxBytes}-byte ` +
            'reading cap. onbase_download_document serves the raw file.'
        );
      }
      const dispositionName = /filename="?([^";]+)"?/.exec(content.contentDisposition ?? '')?.[1];
      const fileName = dispositionName ?? `document-${args.documentId}`;
      const maxChars = args.maxChars ?? 60_000;
      const extracted = await extractText(new Uint8Array(content.bytes), { fileName, maxChars });
      if (!extracted.ok) {
        return errText(
          extracted.err.type === 'UNSUPPORTED_FORMAT'
            ? `"${fileName}" is not a text-extractable format — onbase_download_document serves the raw bytes.`
            : `Could not extract text from "${fileName}" (${extracted.err.type}).`
        );
      }
      const notes = extracted.val.notes.length ? `\n[note: ${extracted.val.notes.join('; ')}]` : '';
      return textResult(`${extracted.val.text}${notes}`);
    }
  );

  server.registerTool(
    'onbase_download_document',
    {
      title: 'OnBase · Read — Get a download link for the raw document',
      description:
        "A link to the document's exact bytes (default rendition, latest revision), for when " +
        'the original file is needed rather than its text. The link is served by Renkei and ' +
        'requires being signed in to this Renkei org in the browser — it is not an anonymous URL.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ documentId: z.string().min(1) }),
    },
    (args: { documentId: string }) => {
      const id = idSegment(args.documentId);
      if (!id) return errText('That is not a usable document id.');
      if (!context.origin) {
        return errText('This deployment has no public base URL, so no download link can be made.');
      }
      return textResult(
        `Download (requires this org's sign-in): ${context.origin}/api/tenant/${context.tenantId}/onbase/documents/${id}/content`
      );
    }
  );

  server.registerTool(
    'onbase_list_document_types',
    {
      title: 'OnBase · Read — List document types',
      description:
        'The document types configured in this OnBase — the vocabulary searches and archiving ' +
        'speak. Names given to other onbase_* tools resolve against this list.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const [types, groups] = await Promise.all([
        loadCatalog(context, auth, 'document-types'),
        loadCatalog(context, auth, 'document-type-groups'),
      ]);
      if (typeof types === 'string') return errText(types);
      if (types.length === 0) return textResult('No document types are visible to your account.');
      const groupLines =
        typeof groups === 'string' || groups.length === 0
          ? []
          : ['', 'Document type groups:', ...groups.map((g) => `  ${displayName(g)} (id ${g.id})`)];
      return textResult(
        [
          'Document types (name — id):',
          ...types.map((t) => `  ${displayName(t)} — id ${t.id}`),
          ...groupLines,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_list_keyword_types',
    {
      title: 'OnBase · Read — List keyword types',
      description:
        'The keyword types configured in this OnBase, with their data types — what search ' +
        'constraints and keyword updates are made of. Names given to other onbase_* tools ' +
        'resolve against this list.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const result = await apiJson(auth, { method: 'GET', path: '/keyword-types' }, 'list keyword types');
      if (typeof result === 'string') return errText(result);
      const items = namedList(result.json);
      if (items.length === 0) return textResult('No keyword types are visible to your account.');
      const dataTypes = new Map<string, string>();
      if (isRecord(result.json) && Array.isArray(result.json.items)) {
        for (const item of result.json.items) {
          if (isRecord(item) && typeof item.id === 'string' && typeof item.dataType === 'string') {
            dataTypes.set(item.id, item.dataType);
          }
        }
      }
      return textResult(
        'Keyword types (name — id — data type):\n' +
          items
            .map((t) => `  ${displayName(t)} — id ${t.id} — ${dataTypes.get(t.id) ?? '?'}`)
            .join('\n')
      );
    }
  );

  server.registerTool(
    'onbase_list_custom_queries',
    {
      title: 'OnBase · Read — List saved custom queries',
      description:
        'The custom queries configured in OnBase — saved searches with the right scope and ' +
        'filters already encoded, runnable with onbase_run_custom_query. Their instructions ' +
        'say what each is for.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const result = await apiJson(auth, { method: 'GET', path: '/custom-queries' }, 'list custom queries');
      if (typeof result === 'string') return errText(result);
      if (!isRecord(result.json) || !Array.isArray(result.json.items) || result.json.items.length === 0) {
        return textResult('No custom queries are visible to your account.');
      }
      const lines: string[] = [];
      for (const item of result.json.items) {
        if (!isRecord(item) || typeof item.id !== 'string') continue;
        const name = str(item.name) || str(item.systemName) || '(unnamed)';
        const kind = str(item.queryType);
        const instructions = str(item.instructions);
        lines.push(
          `  ${name} — id ${item.id}${kind ? ` — ${kind}` : ''}${instructions ? `\n    ${instructions}` : ''}`
        );
      }
      return textResult(`Custom queries:\n${lines.join('\n')}`);
    }
  );

  server.registerTool(
    'onbase_list_notes',
    {
      title: 'OnBase · Read — Notes on a document',
      description:
        'The notes attached to a document revision (default: latest). Encrypted notes are ' +
        'listed but their sensitive text is never fetched — OnBase keeps it behind a separate ' +
        'endpoint deliberately, and so does this tool.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: z.string().min(1),
        revisionId: z.string().optional().describe('Default "latest".'),
      }),
    },
    async (args: { documentId: string; revisionId?: string }) => {
      const id = idSegment(args.documentId);
      const revision = idSegment(args.revisionId ?? 'latest');
      if (!id || !revision) return errText('That is not a usable document or revision id.');
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/documents/${id}/revisions/${revision}/notes` },
        'list the notes'
      );
      if (typeof result === 'string') return errText(result);
      const items = isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
      if (items.length === 0) return textResult('No notes on this document revision.');
      const lines: string[] = [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        const title = str(item.title) || '(untitled)';
        const encrypted = item.isEncryptedNote === true;
        const text = encrypted ? '[encrypted note — sensitive text withheld]' : str(item.text);
        lines.push(
          `  note ${str(item.id)} — ${title} — by user ${str(item.createdUserId) || '?'} on ${str(item.created) || '?'}` +
            (text ? `\n    ${text}` : '')
        );
      }
      return textResult(`Notes:\n${lines.join('\n')}`);
    }
  );

  server.registerTool(
    'onbase_get_document_history',
    {
      title: 'OnBase · Read — Who did what to a document',
      description:
        'The audit history OnBase keeps for one document: actions, when, and by which user id.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: z.string().min(1),
        startDate: z.string().optional().describe('YYYY-MM-DD'),
        endDate: z.string().optional().describe('YYYY-MM-DD'),
      }),
    },
    async (args: { documentId: string; startDate?: string; endDate?: string }) => {
      const id = idSegment(args.documentId);
      if (!id) return errText('That is not a usable document id.');
      const query: Record<string, string> = {};
      if (args.startDate) query.startDate = args.startDate;
      if (args.endDate) query.endDate = args.endDate;
      const result = await apiJson(
        auth,
        { method: 'GET', path: `/documents/${id}/history`, query },
        'read the document history'
      );
      if (typeof result === 'string') return errText(result);
      const items = isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
      if (items.length === 0) return textResult('No history entries for this document.');
      const lines = items
        .filter(isRecord)
        .map(
          (item) =>
            `  ${str(item.logDate) || '?'} — ${str(item.action) || '?'} — user ${str(item.userId) || '?'}` +
            (str(item.message) ? ` — ${str(item.message)}` : '')
        );
      return textResult(`History:\n${lines.join('\n')}`);
    }
  );

  /* ------------------------------- Act ------------------------------- */

  server.registerTool(
    'onbase_request_document_upload',
    {
      title: 'OnBase · Act — Request an upload slot for a new document',
      description:
        'Step 1 of archiving a document into OnBase: mint a Renkei upload endpoint for the ' +
        'file bytes (files are never passed as tool arguments). After the bytes are uploaded ' +
        'and check_file_upload confirms, onbase_archive_document files it under a document ' +
        'type with keywords.',
      inputSchema: z.object({
        filename: z.string().min(1).describe('Name with extension — the extension picks the OnBase file type.'),
        contentType: z.string().optional(),
      }),
    },
    async (args: { filename: string; contentType?: string }) => {
      // The slot's destination starts empty: the executor records the OnBase
      // staging reference into it once the bytes arrive.
      const slot = await createUploadSlot(
        context,
        'onbase-document',
        {},
        { filename: args.filename, contentType: args.contentType }
      );
      if (!slot.ok) return errText(slot.error);
      return textResult(slot.instructions);
    }
  );

  server.registerTool(
    'onbase_archive_document',
    {
      title: 'OnBase · Act — Archive an uploaded file as a document',
      description:
        'Step 2 of archiving: file a completed upload (from onbase_request_document_upload) ' +
        'into OnBase under a document type, with keyword values. Keyword and document-type ' +
        'names are resolved to ids. Starts from the document type\'s default keywords and ' +
        'merges yours over them.',
      inputSchema: z.object({
        uploadId: z.string().uuid().describe('The Renkei upload id whose bytes were uploaded.'),
        documentType: z.string().min(1).describe('Document type name or id to file under.'),
        keywords: z.array(keywordValuesSchema).optional(),
        documentDate: z.string().optional().describe('YYYY-MM-DD; defaults server-side.'),
        comment: z.string().optional().describe('Revision comment, for revisable types.'),
        storeAsNew: z
          .boolean()
          .optional()
          .describe('Force a new document when OnBase finds revision/rendition matches.'),
      }),
    },
    async (args: {
      uploadId: string;
      documentType: string;
      keywords?: z.infer<typeof keywordValuesSchema>[];
      documentDate?: string;
      comment?: string;
      storeAsNew?: boolean;
    }) => {
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const slot = await dbResult.val
        .selectFrom('upload_slots')
        .select(['id', 'kind', 'status', 'destination', 'filename', 'subject'])
        .where('id', '=', args.uploadId)
        .where('tenant_id', '=', context.tenantId)
        .executeTakeFirst();
      if (!slot || slot.kind !== 'onbase-document' || slot.subject !== context.subject) {
        return errText('No OnBase upload with that id belongs to you.');
      }
      if (slot.status !== 'completed') {
        return errText(
          `Upload ${args.uploadId} is ${slot.status} — the file bytes must be uploaded first ` +
            '(check_file_upload shows the state).'
        );
      }
      const destination = isRecord(slot.destination) ? slot.destination : {};
      const onbaseUploadId = str(destination.onbaseUploadId);
      if (!onbaseUploadId) {
        return errText('This upload never reached OnBase staging; request a new upload slot.');
      }

      const typeId = await resolveRef(context, auth, 'document-types', args.documentType, 'document type');
      if (typeof typeId !== 'string') return errText(typeId.refusal);

      // The archive payload requires the COMPLETE keyword collection, so
      // start from the type's defaults (which also carry the keywordGuid
      // the server checks) and merge the caller's values over them.
      const defaults = await apiJson(
        auth,
        { method: 'GET', path: `/document-types/${encodeURIComponent(typeId)}/default-keywords` },
        'read the default keywords'
      );
      if (typeof defaults === 'string') return errText(defaults);
      const defaultCollection = collectionOf(defaults.json);
      if (!defaultCollection) {
        return errText('OnBase returned no usable default keyword collection for that type.');
      }

      const updates = args.keywords
        ? await resolveKeywordUpdates(context, auth, args.keywords)
        : [];
      if (!Array.isArray(updates)) return errText(updates.refusal);
      const merged = mergeKeywordCollections(defaultCollection, updates);
      if (!merged.ok) return errText(merged.err.message ?? 'Could not merge the keywords.');

      // Best-guess file type from the filename extension; the server can
      // often infer, so a failed guess is dropped rather than fatal.
      const extension = slot.filename.includes('.')
        ? slot.filename.slice(slot.filename.lastIndexOf('.') + 1)
        : '';
      let fileTypeId: string | undefined;
      if (extension) {
        const guessed = await apiJson(
          auth,
          { method: 'GET', path: '/default-upload-file-types', query: { extension } },
          'guess the file type'
        );
        if (typeof guessed !== 'string' && isRecord(guessed.json) && str(guessed.json.id)) {
          fileTypeId = str(guessed.json.id);
        }
      }

      const archived = await apiJson(
        auth,
        {
          method: 'POST',
          path: '/documents',
          body: {
            documentTypeId: typeId,
            ...(fileTypeId ? { fileTypeId } : {}),
            ...(args.documentDate ? { documentDate: args.documentDate } : {}),
            ...(args.comment ? { comment: args.comment } : {}),
            ...(args.storeAsNew !== undefined ? { storeAsNew: args.storeAsNew } : {}),
            uploads: [{ id: onbaseUploadId }],
            keywordCollection: merged.val,
          },
        },
        'archive the document'
      );
      if (typeof archived === 'string') return errText(archived);
      if (archived.status === 300) {
        // NOT a success: OnBase found existing revisable/renditionable
        // matches and stored nothing.
        const matches =
          isRecord(archived.json) && Array.isArray(archived.json.items)
            ? archived.json.items
                .filter(isRecord)
                .map((m) => `document ${str(m.id)}`)
                .join(', ')
            : 'existing documents';
        return errText(
          `OnBase did not store a new document: it matched ${matches}. Repeat with ` +
            'storeAsNew: true to force a new document, or archive into the matching document ' +
            'as a revision (not supported by this tool).'
        );
      }
      const newId = isRecord(archived.json) ? str(archived.json.id) : '';
      return textResult(
        `Archived "${slot.filename}" as OnBase document${newId ? ` id ${newId}` : ''}.`
      );
    }
  );

  server.registerTool(
    'onbase_update_keywords',
    {
      title: 'OnBase · Act — Update keyword values on a document',
      description:
        "Change keyword values on a document. OnBase's own API REPLACES the entire keyword " +
        'set on every write; this tool protects against that by reading the current values, ' +
        'merging your changes (each entry is the complete value list for that type; [] blanks ' +
        'it), and writing the whole collection back. Everything you do not name is preserved.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        keywords: z.array(keywordValuesSchema).min(1),
      }),
    },
    async (args: { documentId: string; keywords: z.infer<typeof keywordValuesSchema>[] }) => {
      const id = idSegment(args.documentId);
      if (!id) return errText('That is not a usable document id.');

      const current = await apiJson(
        auth,
        { method: 'GET', path: `/documents/${id}/keywords` },
        'read the current keywords'
      );
      if (typeof current === 'string') return errText(current);
      const collection = collectionOf(current.json);
      if (!collection) return errText('OnBase returned no usable keyword collection to merge into.');

      const updates = await resolveKeywordUpdates(context, auth, args.keywords);
      if (!Array.isArray(updates)) return errText(updates.refusal);
      const merged = mergeKeywordCollections(collection, updates);
      if (!merged.ok) return errText(merged.err.message ?? 'Could not merge the keywords.');

      const written = await apiJson(
        auth,
        { method: 'PUT', path: `/documents/${id}/keywords`, body: merged.val },
        'write the keywords'
      );
      if (typeof written === 'string') return errText(written);
      return textResult(
        `Updated ${updates.length} keyword type(s) on document ${args.documentId}; all other keywords preserved.`
      );
    }
  );

  server.registerTool(
    'onbase_add_note',
    {
      title: 'OnBase · Act — Add a note to a document',
      description:
        'Attach a note (of a configured note type) to a document revision (default: latest). ' +
        'Note types may be given by name; sensitive/encrypted note text is not supported.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        noteType: z.string().min(1).describe('Note type name or id.'),
        text: z.string().optional().describe("The note text; omitted uses the type's default."),
        page: z.number().int().positive().optional().describe('Page to pin the note to (default 1).'),
        revisionId: z.string().optional().describe('Default "latest".'),
      }),
    },
    async (args: {
      documentId: string;
      noteType: string;
      text?: string;
      page?: number;
      revisionId?: string;
    }) => {
      const id = idSegment(args.documentId);
      const revision = idSegment(args.revisionId ?? 'latest');
      if (!id || !revision) return errText('That is not a usable document or revision id.');
      const noteTypeId = await resolveRef(context, auth, 'note-types', args.noteType, 'note type');
      if (typeof noteTypeId !== 'string') return errText(noteTypeId.refusal);

      const created = await apiJson(
        auth,
        {
          method: 'POST',
          path: `/documents/${id}/revisions/${revision}/notes`,
          body: {
            noteTypeId,
            ...(args.text !== undefined ? { text: args.text } : {}),
            ...(args.page !== undefined ? { page: args.page } : {}),
          },
        },
        'add the note'
      );
      if (typeof created === 'string') return errText(created);
      const noteId = isRecord(created.json) ? str(created.json.id) : '';
      return textResult(`Note${noteId ? ` ${noteId}` : ''} added to document ${args.documentId}.`);
    }
  );

  server.registerTool(
    'onbase_reindex_document',
    {
      title: 'OnBase · Act — Reindex a document into another type',
      description:
        'Move a document to a different document type (name resolved to id). Reindexing can ' +
        'change which keywords apply and who can see the document — OnBase enforces both.',
      inputSchema: z.object({
        documentId: z.string().min(1),
        targetDocumentType: z.string().min(1).describe('Document type name or id.'),
        documentDate: z.string().optional().describe('YYYY-MM-DD'),
        comment: z.string().optional().describe('Revision comment, for revisable types.'),
        storeAsNew: z.boolean().optional(),
      }),
    },
    async (args: {
      documentId: string;
      targetDocumentType: string;
      documentDate?: string;
      comment?: string;
      storeAsNew?: boolean;
    }) => {
      const id = idSegment(args.documentId);
      if (!id) return errText('That is not a usable document id.');
      const typeId = await resolveRef(
        context,
        auth,
        'document-types',
        args.targetDocumentType,
        'document type'
      );
      if (typeof typeId !== 'string') return errText(typeId.refusal);

      const reindexed = await apiJson(
        auth,
        {
          method: 'PUT',
          path: `/documents/${id}`,
          body: {
            targetDocumentTypeId: typeId,
            ...(args.documentDate ? { documentDate: args.documentDate } : {}),
            ...(args.comment ? { comment: args.comment } : {}),
            ...(args.storeAsNew !== undefined ? { storeAsNew: args.storeAsNew } : {}),
          },
        },
        'reindex the document'
      );
      if (typeof reindexed === 'string') return errText(reindexed);
      if (reindexed.status === 300) {
        return errText(
          'OnBase did not reindex: it matched existing revisable/renditionable documents. ' +
            'Repeat with storeAsNew: true to force it.'
        );
      }
      return textResult(`Document ${args.documentId} reindexed into type ${args.targetDocumentType}.`);
    }
  );
}

/** Parse a KeywordCollection response into the package's shape, or null. */
function collectionOf(value: unknown): OnBaseKeywordCollection | null {
  if (!isRecord(value) || typeof value.keywordGuid !== 'string' || !Array.isArray(value.items)) {
    return null;
  }
  const items = value.items.filter(isRecord).map((group) => ({
    ...(typeof group.typeGroupId === 'string' ? { typeGroupId: group.typeGroupId } : {}),
    ...(typeof group.groupId === 'string' ? { groupId: group.groupId } : {}),
    ...(typeof group.instanceId === 'string' ? { instanceId: group.instanceId } : {}),
    keywords: (Array.isArray(group.keywords) ? group.keywords.filter(isRecord) : []).map(
      (keyword) => ({
        ...(typeof keyword.typeId === 'string' ? { typeId: keyword.typeId } : {}),
        values: (Array.isArray(keyword.values) ? keyword.values.filter(isRecord) : []).map(
          (value) => ({
            ...(typeof value.value === 'string' ? { value: value.value } : {}),
          })
        ),
      })
    ),
  }));
  return { keywordGuid: value.keywordGuid, items };
}

/** Resolve {type (name), values} updates to typed KeywordUpdates. */
async function resolveKeywordUpdates(
  context: MCPToolContext,
  auth: OnBaseAuth,
  updates: { type: string; values: string[] }[]
): Promise<KeywordUpdate[] | { refusal: string }> {
  const resolved: KeywordUpdate[] = [];
  for (const update of updates) {
    const typeId = await resolveRef(context, auth, 'keyword-types', update.type, 'keyword type');
    if (typeof typeId !== 'string') return typeId;
    resolved.push({ typeId, values: update.values });
  }
  return resolved;
}
