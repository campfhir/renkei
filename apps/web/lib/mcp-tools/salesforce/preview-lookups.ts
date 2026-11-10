/**
 * The names behind the ids a Salesforce write's preview card carries (see
 * ../lookup.ts): a record named by id, an owner or assignee, a record id
 * typed into a lookup field, a record type, a staged file, and the record an
 * external id points at. A record the person named in words needs no lookup.
 * Each lookup only reads, and a failure just leaves the name out — the card
 * then says "the record", never an id.
 *
 * The preview runs outside the tool's own handler, so each lookup enters the
 * org the call names (`orgCall`) before it resolves access, the way the org
 * selection wrapper does for the tool itself.
 */

import { isSalesforceId, nameFieldOf, soqlString, to18 } from '@renkei/connector-salesforce';
import { sbStatFile } from '@/lib/sandbox/service-client';
import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, records, text, type Args, type Names } from '../previews/card';
import { targetOf } from '../sandbox/shared';
import { rec, sfQuery, str, type SalesforceAccess } from './client';
import { orgCall } from './org-choice';
import { fieldOf, resolveRef } from './records';
import { resolveObject, resolveOwner } from './schema';
import type { SalesforceAuth } from './salesforce-auth';

/** Lookup fields shown on a card; the rest stay as typed. */
const MAX_FIELD_IDS = 5;

type Ref = { object?: string; record: string };

export function registerSalesforcePreviewLookups(
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  /** Runs `work` against the org the call names, or {} when there is no access. */
  const inOrg = (tool: string, args: Args, work: (access: SalesforceAccess) => Promise<Names>) =>
    orgCall.run({ org: text(args.org) || undefined, tool }, async () => {
      const access = await auth.resolve();
      return typeof access === 'string' ? {} : work(access);
    });

  const refsOf = (value: unknown, object?: unknown): Ref[] => {
    const entry = record(value);
    const id = text(entry.record);
    if (!isSalesforceId(id)) return [];
    return [{ object: text(entry.object ?? object) || undefined, record: id }];
  };

  /** record:<id> → the record's name, for each id-like reference. */
  const recordNames = async (access: SalesforceAccess, refs: Ref[]): Promise<Names> => {
    const out: Record<string, string> = {};
    await Promise.all(
      refs.map(async (ref) => {
        try {
          const found = await resolveRef(context, access, ref);
          if (typeof found !== 'string' && found.name && found.name !== found.id) {
            out[nameKey('record', ref.record)] = found.name;
          }
        } catch {
          // The card says "the record".
        }
      })
    );
    return out;
  };

  const ownerName = async (access: SalesforceAccess, value: unknown): Promise<Names> => {
    const ref = text(value);
    if (!isSalesforceId(ref)) return {};
    try {
      const found = await resolveOwner(context, access, ref, true);
      return typeof found === 'string' ? {} : { [nameKey('user', ref)]: found.name };
    } catch {
      return {};
    }
  };

  /** Ids typed as the value of a field — a lookup — shown by the name they point at. */
  const fieldIdNames = (access: SalesforceAccess, fields: unknown): Promise<Names> => {
    const ids = Object.values(record(fields))
      .filter((value): value is string => typeof value === 'string' && isSalesforceId(value.trim()))
      .map((value) => value.trim())
      .slice(0, MAX_FIELD_IDS);
    return recordNames(
      access,
      ids.map((id) => ({ record: id }))
    );
  };

  const recordTypeName = async (access: SalesforceAccess, value: unknown): Promise<Names> => {
    const id = text(value);
    if (!isSalesforceId(id)) return {};
    try {
      const found = await sfQuery(
        context,
        access,
        `SELECT Name FROM RecordType WHERE Id = ${soqlString(to18(id))} LIMIT 1`
      );
      const name = found.ok ? str(rec(found.records[0]).Name) : '';
      return name ? { [nameKey('recordType', id)]: name } : {};
    } catch {
      return {};
    }
  };

  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  const related = (args: Args): Ref[] => records(args.relatedTo).flatMap((entry) => refsOf(entry));

  registerPreviewLookups(context, {
    salesforce_create_record: async (args) =>
      inOrg('salesforce_create_record', args, (access) =>
        merge(
          recordNames(access, refsOf(args.parent)),
          fieldIdNames(access, args.fields),
          recordTypeName(access, args.recordType)
        )
      ),

    salesforce_update_record: async (args) =>
      inOrg('salesforce_update_record', args, (access) =>
        merge(recordNames(access, refsOf(args, args.object)), fieldIdNames(access, args.fields))
      ),

    salesforce_upsert_record: async (args) =>
      inOrg('salesforce_upsert_record', args, async (access) => {
        const names = await fieldIdNames(access, args.fields);
        // The record an external id points at, by its own name, when it already exists.
        try {
          const describe = await resolveObject(context, access, text(args.object));
          if (typeof describe === 'string') return names;
          const field = fieldOf(describe, text(args.externalIdField));
          const nameField = nameFieldOf(describe);
          if (field.kind !== 'found' || !nameField) return names;
          const found = await sfQuery(
            context,
            access,
            `SELECT ${nameField.name} FROM ${describe.name} WHERE ${field.value.name} = ${soqlString(text(args.externalId))} LIMIT 1`
          );
          const name = found.ok ? str(rec(found.records[0])[nameField.name]) : '';
          return name ? { ...names, [nameKey('external', text(args.externalId))]: name } : names;
        } catch {
          return names;
        }
      }),

    salesforce_relate_records: async (args) =>
      inOrg('salesforce_relate_records', args, (access) =>
        recordNames(access, [...refsOf(args.from), ...refsOf(args.to)])
      ),

    salesforce_log_activity: async (args) =>
      inOrg('salesforce_log_activity', args, (access) => recordNames(access, related(args))),

    salesforce_create_task: async (args) =>
      inOrg('salesforce_create_task', args, (access) =>
        merge(recordNames(access, related(args)), ownerName(access, args.assignee))
      ),

    salesforce_add_note: async (args) =>
      inOrg('salesforce_add_note', args, (access) =>
        recordNames(access, refsOf(args, args.object))
      ),

    salesforce_attach_file: async (args) =>
      inOrg('salesforce_attach_file', args, async (access) => {
        const refs = [
          ...refsOf(args, args.object),
          ...records(args.alsoOn).flatMap((entry) => refsOf(entry)),
        ];
        const file = async (): Promise<Names> => {
          const target = targetOf(context);
          const id = text(args.fileId);
          if (typeof target === 'string' || !id) return {};
          try {
            const stat = await sbStatFile(target, id);
            return stat.ok ? { [nameKey('file', id)]: stat.val.filename } : {};
          } catch {
            return {};
          }
        };
        return merge(recordNames(access, refs), file());
      }),
  });
}
