/**
 * The salesforce_ writes that are cards first: many records at once, a
 * parent created with its children, deletes, and owner changes
 * (docs/salesforce-connectors-design.md, "Confirm rule"). The preview
 * resolves every record and checks every value, and shows exactly what will
 * change on the directory_action_preview card; the confirm acts on the ids
 * the preview resolved — never on names again — re-checks, and sends one
 * all-or-none request (sObject Collections, or sObject Tree), so a batch
 * applies entirely or not at all.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  isSalesforceId,
  nameFieldOf,
  soqlString,
  type DescribeSObject,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  DIRECTORY_ACTION_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import { previewResult } from '../entra-developer/provision';
import type { SalesforceAuth } from './salesforce-auth';
import {
  errText,
  rec,
  recordUrl,
  recs,
  sfQuery,
  sfRequest,
  str,
  textResult,
  type SalesforceAccess,
} from './client';
import { describeObject, resolveObject, resolveOwner, resolveRecord } from './schema';
import { sfQueryPolicy } from './policy';
import { prepareWrite, blocked, display } from './writes';
import { fieldsField, objectField, recordField } from './fields';
import { resolveRef } from './records';

/** Ids shown on a card are looked up this many at a time at most; the rest read as "a record". */
const MAX_NAMED_IDS = 20;

/**
 * The names of the records behind any ids among `values` (a lookup field is
 * written as the id it points at), so a card shows "Acme", never "001…".
 * A lookup that fails leaves the id out of the map; `shown` then says so.
 */
async function nameIds(
  context: MCPToolContext,
  access: SalesforceAccess,
  values: unknown[]
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && isSalesforceId(value))
    ),
  ].slice(0, MAX_NAMED_IDS);
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const found = await resolveRef(context, access, { record: id });
        if (typeof found !== 'string' && found.name && found.name !== found.id) {
          names.set(id, found.name);
        }
      } catch {
        // Falls back to "a record".
      }
    })
  );
  return names;
}

/** A field value for a card: an id becomes the record's name; anything else as `display` has it. */
function shown(value: unknown, names: Map<string, string>): string {
  if (typeof value === 'string' && isSalesforceId(value)) return names.get(value) ?? 'a record';
  return display(value);
}

/** A record's name for a card; objects with no name field would otherwise show their id. */
function nameOnCard(entry: { id: string; name: string }, label: string): string {
  return entry.name && entry.name !== entry.id ? entry.name : `A ${label}`;
}

const MAX_BATCH = 200;
/** Records listed on a card; the rest are counted. */
const MAX_SHOWN = 25;

const idListField = z
  .array(z.string().regex(/^[a-zA-Z0-9]{18}$/))
  .min(1)
  .max(MAX_BATCH);

/** Records of one object by id or name, with their current values for `fields`. */
async function resolveMany(
  context: MCPToolContext,
  access: SalesforceAccess,
  describe: DescribeSObject,
  refs: string[],
  fields: string[] = []
): Promise<{ id: string; name: string; current: Record<string, unknown> }[] | string> {
  const ids: { id: string; name: string }[] = [];
  for (const ref of refs) {
    const found = await resolveRecord(context, access, describe, ref);
    if (typeof found === 'string') return found;
    if (!ids.some((entry) => entry.id === found.id)) ids.push(found);
  }
  const nameField = nameFieldOf(describe);
  const select = [
    ...new Set(['Id', 'LastModifiedDate', ...(nameField ? [nameField.name] : []), ...fields]),
  ];
  if (describe.fields.some((f) => f.name === 'RecordTypeId')) select.push('RecordTypeId');
  const current = await sfQueryPolicy(
    context,
    access,
    `SELECT ${[...new Set(select)].join(', ')} FROM ${describe.name} WHERE Id IN (${ids
      .map((entry) => soqlString(entry.id))
      .join(', ')})`
  );
  if (!current.ok) return current.error;
  return ids.map((entry) => ({
    ...entry,
    current: current.records.find((row) => str(row.Id) === entry.id) ?? {},
  }));
}

function collectionErrors(body: unknown): string[] {
  return recs(body)
    .filter((row) => row.success === false)
    .flatMap((row) =>
      recs(row.errors).map(
        (error) =>
          `${str(row.id) || 'a record'}: ${str(error.statusCode)} ${str(error.message)}` +
          (Array.isArray(error.fields) && error.fields.length
            ? ` (field: ${error.fields.join(', ')})`
            : '')
      )
    );
}

export function registerBulkTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  // ———————————————————— update many records ————————————————————

  const updatesSchema = z.object({
    object: objectField,
    updates: z
      .array(z.object({ record: recordField, fields: fieldsField }))
      .min(1)
      .max(MAX_BATCH)
      .describe('Each record and the fields to change on it.'),
  });

  const updatesConfirmSchema = z.object({
    object: z.string().min(1),
    updates: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9]{18}$/),
          fields: z.record(z.string(), z.unknown()),
        })
      )
      .min(1)
      .max(MAX_BATCH),
  });

  server.registerTool(
    'salesforce_update_records_preview',
    {
      title: 'Salesforce · Act — Preview changing many records',
      description:
        'Show the person a card to confirm or cancel changing fields on several records of one ' +
        'object (up to 200), all or none. Each value is checked first; the card lists every ' +
        'record and every field’s old and new value. The only way to change more than one record ' +
        'at once — the person decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: updatesSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const resolved: {
        id: string;
        name: string;
        values: Record<string, unknown>;
        current: Record<string, unknown>;
      }[] = [];
      const errors: string[] = [];
      for (const update of args.updates) {
        const found = await resolveRecord(context, access, describe, update.record);
        if (typeof found === 'string') {
          errors.push(found);
          continue;
        }
        const many = await resolveMany(
          context,
          access,
          describe,
          [found.id],
          Object.keys(update.fields).filter(
            (k) => /^[A-Za-z][A-Za-z0-9_]*$/.test(k) && describe.fields.some((f) => f.name === k)
          )
        );
        const current = typeof many === 'string' ? {} : (many[0]?.current ?? {});
        const prepared = await prepareWrite(context, access, describe, update.fields, 'update', {
          recordTypeId: typeof current.RecordTypeId === 'string' ? current.RecordTypeId : null,
          current,
        });
        if (prepared.errors.length > 0) {
          errors.push(`${found.name}: ${prepared.errors.join('; ')}`);
          continue;
        }
        resolved.push({ ...found, values: prepared.values, current });
      }
      if (errors.length > 0) return errText(errors.join('\n'));
      const label = (name: string) => describe.fields.find((f) => f.name === name)?.label ?? name;
      const names = await nameIds(
        context,
        access,
        resolved
          .slice(0, MAX_SHOWN)
          .flatMap((entry) => [
            ...Object.values(entry.values),
            ...Object.keys(entry.values).map((key) => entry.current[key]),
          ])
      );
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Update records',
        tone: 'caution',
        title: `Change ${resolved.length} ${resolved.length === 1 ? describe.label : (describe.labelPlural ?? describe.label)}`,
        subtitle: `Salesforce · ${new URL(access.instanceUrl).hostname}`,
        person: {
          name: `${resolved.length} record${resolved.length === 1 ? '' : 's'}`,
          detail: describe.label,
        },
        fields: resolved.slice(0, MAX_SHOWN).flatMap((entry) =>
          Object.entries(entry.values).map(([key, value]) => ({
            label: `${nameOnCard(entry, describe.label)} · ${label(key)}`,
            value: shown(value, names),
            ...(key in entry.current ? { oldValue: shown(entry.current[key], names) } : {}),
          }))
        ),
        groupLists:
          resolved.length > MAX_SHOWN
            ? [
                {
                  label: `And ${resolved.length - MAX_SHOWN} more`,
                  groups: resolved.slice(MAX_SHOWN).map((e) => nameOnCard(e, describe.label)),
                  tone: 'muted',
                },
              ]
            : undefined,
        confirmTool: 'salesforce_update_records_confirm',
        confirmLabel: `Change ${resolved.length} record${resolved.length === 1 ? '' : 's'}`,
        confirmArgs: {
          org: access.connector,
          object: describe.name,
          updates: resolved.map((entry) => ({ id: entry.id, fields: entry.values })),
        },
      });
    }
  );

  server.registerTool(
    'salesforce_update_records_confirm',
    {
      title: 'Salesforce · Act — Execute a confirmed change to many records',
      description:
        'Change the records the person confirmed on the preview card, all or none.' +
        confirmGuard('salesforce_update_records_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: updatesConfirmSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await describeObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const records: Record<string, unknown>[] = [];
      for (const update of args.updates) {
        const prepared = await prepareWrite(context, access, describe, update.fields, 'update');
        if (prepared.errors.length > 0) return errText(prepared.errors.join('\n'));
        records.push({ attributes: { type: describe.name }, Id: update.id, ...prepared.values });
      }
      const result = await sfRequest(context, access, 'PATCH', '/composite/sobjects', {
        allOrNone: true,
        records,
      });
      if (!result.ok) return blocked(result, 'change the records');
      const failures = collectionErrors(result.body);
      if (failures.length > 0) {
        return errText(['Salesforce changed nothing (all or none):', ...failures].join('\n'));
      }
      return textResult(`Changed ${records.length} ${describe.labelPlural ?? describe.label}.`);
    }
  );

  // ———————————————————— delete records ————————————————————

  const deleteSchema = z.object({
    object: objectField,
    records: z.array(recordField).min(1).max(MAX_BATCH),
  });

  server.registerTool(
    'salesforce_delete_records_preview',
    {
      title: 'Salesforce · Act — Preview deleting records',
      description:
        'Show the person a card to confirm or cancel deleting records of one object (up to 200), ' +
        'all or none. The card names each record and the child records that are deleted with it ' +
        '(master-detail children). Deleted records stay in the Recycle Bin for 15 days. The only ' +
        'way to delete — the person decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: deleteSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const found = await resolveMany(context, access, describe, args.records);
      if (typeof found === 'string') return errText(found);
      const ids = found.map((entry) => entry.id);
      // What goes with them: master-detail children, counted.
      const cascades: string[] = [];
      for (const rel of (describe.childRelationships ?? [])
        .filter((r) => r.cascadeDelete)
        .slice(0, 10)) {
        const count = await sfQuery(
          context,
          access,
          `SELECT COUNT() FROM ${rel.childSObject} WHERE ${rel.field} IN (${ids.map(soqlString).join(', ')})`
        );
        if (count.ok && count.totalSize > 0) {
          const child = await describeObject(context, access, rel.childSObject);
          const label =
            typeof child === 'string' ? rel.childSObject : (child.labelPlural ?? child.label);
          cascades.push(`${count.totalSize} ${label}`);
        }
      }
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Delete records',
        tone: 'caution',
        title: `Delete ${found.length} ${found.length === 1 ? describe.label : (describe.labelPlural ?? describe.label)}`,
        subtitle: `Salesforce · ${new URL(access.instanceUrl).hostname} · Recycle Bin keeps them 15 days`,
        person: {
          name: `${found.length} record${found.length === 1 ? '' : 's'}`,
          detail: describe.label,
        },
        groupLists: [
          {
            label: 'Deleted',
            groups: found.map((entry) => nameOnCard(entry, describe.label)),
            tone: 'remove',
          },
          ...(cascades.length
            ? [{ label: 'Deleted with them', groups: cascades, tone: 'remove' as const }]
            : []),
        ],
        confirmTool: 'salesforce_delete_records_confirm',
        confirmLabel: `Delete ${found.length}`,
        confirmArgs: {
          org: access.connector,
          object: describe.name,
          ids,
        },
      });
    }
  );

  server.registerTool(
    'salesforce_delete_records_confirm',
    {
      title: 'Salesforce · Act — Execute a confirmed delete',
      description:
        'Delete the records the person confirmed on the preview card, all or none.' +
        confirmGuard('salesforce_delete_records_preview'),
      annotations: { readOnlyHint: false, destructiveHint: true },
      _meta: APP_ONLY_META,
      inputSchema: z.object({ object: z.string().min(1), ids: idListField }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const result = await sfRequest(
        context,
        access,
        'DELETE',
        `/composite/sobjects?ids=${args.ids.map(encodeURIComponent).join(',')}&allOrNone=true`
      );
      if (!result.ok) return blocked(result, 'delete the records');
      const failures = collectionErrors(result.body);
      if (failures.length > 0) {
        return errText(['Salesforce deleted nothing (all or none):', ...failures].join('\n'));
      }
      return textResult(
        `Deleted ${args.ids.length} record${args.ids.length === 1 ? '' : 's'}; they stay in the Recycle Bin for 15 days.`
      );
    }
  );

  // ———————————————————— change owners ————————————————————

  server.registerTool(
    'salesforce_change_owner_preview',
    {
      title: 'Salesforce · Act — Preview reassigning records',
      description:
        'Show the person a card to confirm or cancel giving records (up to 200, one object) a new ' +
        'owner — a user, or a queue where the object allows one. A new owner changes who can see ' +
        'and edit them, so this is always a card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        object: objectField,
        records: z.array(recordField).min(1).max(MAX_BATCH),
        newOwner: z
          .string()
          .min(1)
          .describe('The new owner: a name, username, email, queue name or id.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const ownerField = describe.fields.find((f) => f.name === 'OwnerId');
      if (!ownerField) {
        return errText(
          `${describe.label} records have no owner of their own (their parent's owner decides access).`
        );
      }
      const owner = await resolveOwner(
        context,
        access,
        args.newOwner,
        (ownerField.referenceTo ?? []).includes('Group')
      );
      if (typeof owner === 'string') return errText(owner);
      const found = await resolveMany(context, access, describe, args.records, ['Owner.Name']);
      if (typeof found === 'string') return errText(found);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Change owner',
        tone: 'caution',
        title: `Give ${found.length} ${found.length === 1 ? describe.label : (describe.labelPlural ?? describe.label)} to ${owner.name}`,
        subtitle: `Salesforce · ${new URL(access.instanceUrl).hostname} · changes who can see them`,
        person: { name: owner.name, detail: owner.kind === 'Queue' ? 'Queue' : 'New owner' },
        groupLists: [
          {
            label: 'Records',
            groups: found.map(
              (entry) =>
                `${nameOnCard(entry, describe.label)} — from ${str(rec(entry.current.Owner).Name) || 'current owner'}`
            ),
          },
        ],
        confirmTool: 'salesforce_change_owner_confirm',
        confirmLabel: `Reassign ${found.length}`,
        confirmArgs: {
          org: access.connector,
          object: describe.name,
          ids: found.map((entry) => entry.id),
          ownerId: owner.id,
        },
      });
    }
  );

  server.registerTool(
    'salesforce_change_owner_confirm',
    {
      title: 'Salesforce · Act — Execute a confirmed reassignment',
      description:
        'Give the records the person confirmed their new owner, all or none.' +
        confirmGuard('salesforce_change_owner_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        object: z.string().min(1),
        ids: idListField,
        ownerId: z.string().regex(/^[a-zA-Z0-9]{18}$/),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const result = await sfRequest(context, access, 'PATCH', '/composite/sobjects', {
        allOrNone: true,
        records: args.ids.map((id) => ({
          attributes: { type: args.object },
          Id: id,
          OwnerId: args.ownerId,
        })),
      });
      if (!result.ok) return blocked(result, 'reassign the records');
      const failures = collectionErrors(result.body);
      if (failures.length > 0) {
        return errText(['Salesforce reassigned nothing (all or none):', ...failures].join('\n'));
      }
      return textResult(`Reassigned ${args.ids.length} record${args.ids.length === 1 ? '' : 's'}.`);
    }
  );

  // ———————————————————— a parent with its children ————————————————————

  const treeSchema = z.object({
    object: objectField,
    fields: fieldsField,
    children: z
      .array(
        z.object({
          relationship: z
            .string()
            .min(1)
            .describe('The child relationship name (Contacts, Line_Items__r).'),
          records: z.array(fieldsField).min(1).max(50),
        })
      )
      .min(1)
      .max(5),
  });

  server.registerTool(
    'salesforce_create_record_tree_preview',
    {
      title: 'Salesforce · Act — Preview creating a record with its children',
      description:
        'Show the person a card to confirm or cancel creating one record together with child ' +
        'records (an account with its contacts, a visit with its attendees), all or none. Every ' +
        'value is checked first.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: treeSchema,
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const parent = await prepareWrite(context, access, describe, args.fields, 'create');
      const errors = [...parent.errors];
      const children: {
        relationship: string;
        object: string;
        field: string;
        records: Record<string, unknown>[];
      }[] = [];
      for (const group of args.children) {
        const rel = (describe.childRelationships ?? []).find(
          (candidate) =>
            candidate.relationshipName?.toLowerCase() === group.relationship.toLowerCase()
        );
        if (!rel?.relationshipName) {
          errors.push(`${describe.name} has no child relationship "${group.relationship}".`);
          continue;
        }
        const child = await describeObject(context, access, rel.childSObject);
        if (typeof child === 'string') {
          errors.push(child);
          continue;
        }
        const records: Record<string, unknown>[] = [];
        for (const fields of group.records) {
          // The link to the parent is the tree's to make; not required here.
          const prepared = await prepareWrite(context, access, child, fields, 'create');
          const own = prepared.errors.filter((error) => !error.includes(rel.field));
          if (own.length > 0) errors.push(`${child.label}: ${own.join('; ')}`);
          else records.push(prepared.values);
        }
        children.push({
          relationship: rel.relationshipName,
          object: child.name,
          field: rel.field,
          records,
        });
      }
      if (errors.length > 0) return errText(errors.join('\n'));
      const total = children.reduce((n, group) => n + group.records.length, 0);
      const names = await nameIds(context, access, [
        ...Object.values(parent.values),
        ...children.flatMap((group) => group.records.flatMap((row) => Object.values(row))),
      ]);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Create records',
        tone: 'positive',
        title: `Create a ${describe.label} with ${total} related record${total === 1 ? '' : 's'}`,
        subtitle: `Salesforce · ${new URL(access.instanceUrl).hostname}`,
        person: { name: describe.label, detail: 'New record' },
        fields: Object.entries(parent.values).map(([key, value]) => ({
          label: key,
          value: shown(value, names),
        })),
        groupLists: children.map((group) => ({
          label: `${group.object} (${group.relationship})`,
          groups: group.records.map((record) =>
            Object.entries(record)
              .map(([key, value]) => `${key}: ${shown(value, names)}`)
              .join(', ')
          ),
          tone: 'add' as const,
        })),
        confirmTool: 'salesforce_create_record_tree_confirm',
        confirmLabel: `Create ${total + 1} records`,
        confirmArgs: {
          org: access.connector,
          object: describe.name,
          fields: parent.values,
          children: children.map((group) => ({
            relationship: group.relationship,
            records: group.records,
          })),
        },
      });
    }
  );

  server.registerTool(
    'salesforce_create_record_tree_confirm',
    {
      title: 'Salesforce · Act — Execute a confirmed record tree',
      description:
        'Create the record and children the person confirmed on the preview card, all or none.' +
        confirmGuard('salesforce_create_record_tree_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        object: z.string().min(1),
        fields: z.record(z.string(), z.unknown()),
        children: z
          .array(
            z.object({
              relationship: z.string().min(1),
              records: z.array(z.record(z.string(), z.unknown())).max(50),
            })
          )
          .max(5),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await describeObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const tree: Record<string, unknown> = {
        attributes: { type: describe.name, referenceId: 'parent' },
        ...args.fields,
      };
      for (const [groupIndex, group] of args.children.entries()) {
        const rel = (describe.childRelationships ?? []).find(
          (r) => r.relationshipName === group.relationship
        );
        if (!rel)
          return errText(`${describe.name} has no child relationship ${group.relationship}.`);
        tree[group.relationship] = {
          records: group.records.map((record, index) => ({
            attributes: { type: rel.childSObject, referenceId: `child${groupIndex}_${index}` },
            ...record,
          })),
        };
      }
      const result = await sfRequest(
        context,
        access,
        'POST',
        `/composite/tree/${encodeURIComponent(describe.name)}`,
        {
          records: [tree],
        }
      );
      if (!result.ok) return blocked(result, 'create the records');
      const body = rec(result.body);
      if (body.hasErrors === true) {
        return errText(
          [
            'Salesforce created nothing (all or none):',
            ...recs(body.results).flatMap((row) =>
              recs(row.errors).map(
                (error) => `${str(row.referenceId)}: ${str(error.statusCode)} ${str(error.message)}`
              )
            ),
          ].join('\n')
        );
      }
      const results = recs(body.results);
      const parentId = str(results.find((row) => str(row.referenceId) === 'parent')?.id);
      return textResult(
        `Created ${describe.label} ${parentId} with ${results.length - 1} related record${results.length === 2 ? '' : 's'} — ${recordUrl(access, parentId)}`
      );
    }
  );
}
