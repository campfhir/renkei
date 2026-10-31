/**
 * The names behind the ids an OnBase act's preview card carries (see
 * ../lookup.ts): a document's name, and the document type / keyword type /
 * group an argument names by id or by name. Each lookup reads (one document,
 * or the connector's own cached catalogs) and a failure just leaves the name
 * out, so the card says "a document" rather than an id.
 *
 * What the call gives is "a name or an id" for most of these, so each entry
 * is keyed by the value as given and answers the catalog's own name for it.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, records, strings, text, type Args, type Names } from '../previews/card';

export interface CatalogEntry {
  id: string;
  name?: string;
  systemName?: string;
}

export interface OnbasePreviewDeps {
  /** One catalog's entries; a string is a refusal. */
  catalog(kind: string): Promise<CatalogEntry[] | string>;
  /** The name of one document, or '' when it cannot be read. */
  documentName?(id: string): Promise<string>;
}

type Want = { catalog: string; kind: string; values: string[] };

async function namesFor(deps: OnbasePreviewDeps, wants: Want[]): Promise<Names> {
  const out: Record<string, string> = {};
  await Promise.all(
    wants
      .filter((want) => want.values.length > 0)
      .map(async (want) => {
        let entries: CatalogEntry[] | string;
        try {
          entries = await deps.catalog(want.catalog);
        } catch {
          return;
        }
        if (typeof entries === 'string') return;
        for (const value of want.values) {
          const folded = value.toLowerCase();
          const hit =
            entries.find((entry) => entry.id === value) ??
            entries.find(
              (entry) => (entry.name ?? entry.systemName ?? '').toLowerCase() === folded
            );
          const name = hit?.name ?? hit?.systemName;
          if (name) out[nameKey(want.kind, value)] = name;
        }
      })
  );
  return out;
}

const one = (value: unknown): string[] => (text(value) ? [text(value)] : []);

/** Document Management API: documents, and the types on a document's cards. */
export function registerOnbasePreviewLookups(
  context: MCPToolContext,
  deps: OnbasePreviewDeps
): void {
  const document = async (args: Args): Promise<Names> => {
    const id = text(args.documentId);
    if (!id || !deps.documentName) return {};
    try {
      const name = await deps.documentName(id);
      return name ? { [nameKey('document', id)]: name } : {};
    } catch {
      return {};
    }
  };
  const keywordTypes = (args: Args): Want => ({
    catalog: 'keyword-types',
    kind: 'keyword type',
    values: records(args.keywords)
      .map((entry) => text(entry.type))
      .filter(Boolean),
  });
  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  registerPreviewLookups(context, {
    onbase_add_note: document,
    onbase_update_keywords: (args) => merge(document(args), namesFor(deps, [keywordTypes(args)])),
    onbase_reindex_document: (args) =>
      merge(
        document(args),
        namesFor(deps, [
          {
            catalog: 'document-types',
            kind: 'document type',
            values: one(args.targetDocumentType),
          },
        ])
      ),
    onbase_archive_document: (args) =>
      namesFor(deps, [
        { catalog: 'document-types', kind: 'document type', values: one(args.documentType) },
        keywordTypes(args),
      ]),
  });
}

/** Administration API: the catalogs its arguments name by id or by name. */
export function registerOnbaseAdminPreviewLookups(
  context: MCPToolContext,
  deps: OnbasePreviewDeps
): void {
  const userGroups = (args: Args): string[] => [
    ...strings(args.userGroups),
    ...records(args.userGroups).map((entry) => text(entry.userGroup)),
  ];
  const lookup = (args: Args): Promise<Names> =>
    namesFor(deps, [
      { catalog: 'document-types', kind: 'document type', values: one(args.documentType) },
      { catalog: 'keyword-types', kind: 'keyword type', values: one(args.keywordType) },
      {
        catalog: 'keyword-types',
        kind: 'keyword type',
        values: [
          ...records(args.assignments).map((entry) => text(entry.keywordType)),
          ...records(args.keywordTypes).map((entry) => text(entry.keywordType) || text(entry.name)),
        ].filter(Boolean),
      },
      {
        catalog: 'document-type-groups',
        kind: 'document type group',
        values: one(args.documentTypeGroup),
      },
      {
        catalog: 'keyword-type-groups',
        kind: 'keyword type group',
        values: one(args.keywordTypeGroup),
      },
      { catalog: 'file-types', kind: 'file type', values: one(args.defaultFileFormat) },
      { catalog: 'disk-groups', kind: 'disk group', values: one(args.defaultDiskGroup) },
      { catalog: 'user-groups', kind: 'user group', values: userGroups(args) },
    ]);
  registerPreviewLookups(context, {
    onbase_admin_create_document_type: lookup,
    onbase_admin_create_keyword_type: lookup,
    onbase_admin_create_document_type_group: lookup,
    onbase_admin_create_keyword_type_group: lookup,
    onbase_admin_create_file_type: lookup,
    onbase_admin_update_document_type: lookup,
    onbase_admin_update_keyword_type: lookup,
    onbase_admin_assign_keyword_types: lookup,
    onbase_admin_assign_document_type_user_groups: lookup,
    onbase_admin_assign_document_type_group_user_groups: lookup,
  });
}
