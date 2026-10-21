/**
 * The salesforce_ single-record writes: create, update and upsert any
 * record, relate two records through their junction object, and the
 * everyday activity — log a call or meeting, create a follow-up task, add a
 * note. Direct, not preview + confirm: that is how people use a CRM, and the
 * result is the receipt (docs/salesforce-connectors-design.md, "Confirm
 * rule"). Many records at once, deletes and owner changes are cards
 * (bulk.ts).
 *
 * Every write:
 *  - resolves lookup values given as names, and checks every value against
 *    the object's describe before anything is sent (checkWrite);
 *  - updates with If-Unmodified-Since, so a colleague's save in between is a
 *    412 to re-read, not a lost update;
 *  - reads the record back and reports what changed — including the fields
 *    the org's own automation set — so nobody is surprised by a stamped date;
 *  - returns a blocked save in Salesforce's own words, with the field the
 *    validation rule is attached to, so the model asks the person for that
 *    value rather than inventing one.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  checkWrite,
  findByNameOrLabel,
  findRelationshipPaths,
  isSalesforceId,
  type DescribeSObject,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from './salesforce-auth';
import {
  describeErrors,
  errText,
  rec,
  recordUrl,
  sfGet,
  sfRequest,
  str,
  textResult,
  type SalesforceAccess,
  type SalesforceResult,
} from './client';
import {
  describeObject,
  invalidateDescribe,
  recordTypePicklists,
  resolveObject,
  resolveOwner,
  resolveRecord,
  resolveRecordType,
} from './schema';
import { SYSTEM_FIELDS, resolveRef } from './records';
import { fieldsField, objectField, recordField, recordRefField } from './fields';

export interface PreparedWrite {
  values: Record<string, unknown>;
  errors: string[];
}

/**
 * Lookup values given as names become ids (a single-target lookup only; a
 * polymorphic one needs an id), then every value is checked against the
 * describe — the record type's picklist values when there is one.
 */
export async function prepareWrite(
  context: MCPToolContext,
  access: SalesforceAccess,
  describe: DescribeSObject,
  fields: Record<string, unknown>,
  mode: 'create' | 'update',
  options: { recordTypeId?: string | null; current?: Record<string, unknown> } = {}
): Promise<PreparedWrite> {
  const resolved: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const found = findByNameOrLabel(describe.fields, key);
    if (
      found.kind === 'found' &&
      found.value.type === 'reference' &&
      typeof value === 'string' &&
      value.trim() &&
      !isSalesforceId(value.trim())
    ) {
      const targets = found.value.referenceTo ?? [];
      if (targets.length !== 1) {
        errors.push(
          `${found.value.name} can point at ${targets.join(' or ')} — give the record's id.`
        );
        continue;
      }
      if (targets[0] === 'User') {
        const owner = await resolveOwner(context, access, value, false);
        if (typeof owner === 'string') errors.push(`${found.value.name}: ${owner}`);
        else resolved[found.value.name] = owner.id;
        continue;
      }
      const target = await describeObject(context, access, targets[0]);
      if (typeof target === 'string') {
        errors.push(`${found.value.name}: ${target}`);
        continue;
      }
      const record = await resolveRecord(context, access, target, value);
      if (typeof record === 'string') errors.push(`${found.value.name}: ${record}`);
      else resolved[found.value.name] = record.id;
      continue;
    }
    resolved[key] = value;
  }
  const recordTypePicklistsFor = options.recordTypeId
    ? await recordTypePicklists(context, access, describe.name, options.recordTypeId)
    : undefined;
  const checked = checkWrite(describe, resolved, mode, {
    recordTypePicklists: recordTypePicklistsFor,
    current: options.current,
  });
  return { values: checked.values, errors: [...errors, ...checked.errors] };
}

/** Salesforce's own words for a blocked save, with the field a rule names. */
export function blocked(result: Extract<SalesforceResult, { ok: false }>, what: string) {
  const own = describeErrors(result.errors);
  const fields = [...new Set(result.errors.flatMap((error) => error.fields))];
  return errText(
    [
      `Salesforce did not ${what}:`,
      own || result.error,
      ...(fields.length
        ? [
            `Ask the person for ${fields.join(', ')} rather than guessing a value; a validation ` +
              'rule set by the org requires it.',
          ]
        : []),
    ].join('\n')
  );
}

/** The schema moved under us (a field or picklist value the cache did not know): describe again next time. */
function forgetSchemaOn(result: SalesforceResult, access: SalesforceAccess, object: string): void {
  if (
    !result.ok &&
    result.errors.some((error) =>
      /INVALID_FIELD|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST|INVALID_TYPE|bad value for restricted picklist/i.test(
        `${error.errorCode} ${error.message}`
      )
    )
  ) {
    invalidateDescribe(access, object);
  }
}

/** The whole record as Salesforce holds it now. */
async function readRecord(
  context: MCPToolContext,
  access: SalesforceAccess,
  object: string,
  id: string
): Promise<Record<string, unknown> | string> {
  const result = await sfGet(
    context,
    access,
    `/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`
  );
  if (!result.ok) return result.error;
  const record = rec(result.body);
  delete record.attributes;
  return record;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(blank)';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * What a write changed: the fields sent (old → new), then what the org's
 * own automation set alongside (stamped dates, rolled-up totals).
 */
export function changeLines(
  describe: DescribeSObject,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sent: string[]
): string[] {
  const label = (name: string) => describe.fields.find((f) => f.name === name)?.label ?? name;
  const lines: string[] = [];
  const automation: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (SYSTEM_FIELDS.has(key) || key === 'attributes') continue;
    const old = before[key];
    if (JSON.stringify(old ?? null) === JSON.stringify(value ?? null)) continue;
    const line = `${label(key)} (${key}): ${display(old)} → ${display(value)}`;
    if (sent.includes(key)) lines.push(line);
    else automation.push(line);
  }
  for (const key of sent) {
    if (!lines.some((line) => line.includes(`(${key})`))) {
      lines.push(`${label(key)} (${key}): unchanged (${display(after[key])})`);
    }
  }
  return [
    ...lines,
    ...(automation.length
      ? ['Also set by the org’s automation:', ...automation.map((l) => `  ${l}`)]
      : []),
  ];
}

function httpDate(iso: unknown): string | null {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toUTCString();
}

export function registerWriteTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_create_record',
    {
      title: 'Salesforce · Act — Create a record',
      description:
        'Create one record of any object, standard or custom. Field values are checked against ' +
        'the object first (required fields, picklist values for the record type, types); lookups ' +
        'take an id or a name. `parent` links it to a record by choosing the lookup field to that ' +
        'record’s object. The result shows what Salesforce set, including fields the org’s ' +
        'automation filled in. A blocked save comes back in Salesforce’s words — ask the person ' +
        'for what it names.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        fields: fieldsField,
        recordType: z.string().optional().describe('The record type, by name or id.'),
        parent: recordRefField
          .optional()
          .describe(
            'A record to link the new one to, through the lookup field that points at its object.'
          ),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const fields: Record<string, unknown> = { ...args.fields };

      let recordTypeId: string | null = null;
      if (args.recordType) {
        const resolved = resolveRecordType(describe, args.recordType);
        if (typeof resolved !== 'string') return errText(resolved.error);
        recordTypeId = resolved;
        fields.RecordTypeId = resolved;
      }
      if (args.parent) {
        const parent = await resolveRef(context, access, args.parent);
        if (typeof parent === 'string') return errText(parent);
        const lookups = findRelationshipPaths(describe, parent.describe).filter(
          (path) => path.kind === 'lookup'
        );
        if (lookups.length === 0) {
          return errText(`${describe.name} has no lookup to ${parent.describe.name}.`);
        }
        if (lookups.length > 1) {
          return errText(
            `${describe.name} points at ${parent.describe.name} more than one way: ${lookups
              .map((path) => (path.kind === 'lookup' ? path.field : ''))
              .join(', ')}. Set the field you mean in fields instead.`
          );
        }
        const only = lookups[0];
        if (only.kind === 'lookup') fields[only.field] = parent.id;
      }

      const prepared = await prepareWrite(context, access, describe, fields, 'create', {
        recordTypeId,
      });
      if (prepared.errors.length > 0) return errText(prepared.errors.join('\n'));
      const result = await sfRequest(
        context,
        access,
        'POST',
        `/sobjects/${encodeURIComponent(describe.name)}`,
        prepared.values
      );
      forgetSchemaOn(result, access, describe.name);
      if (!result.ok) return blocked(result, `create the ${describe.label}`);
      const id = str(rec(result.body).id);
      const after = await readRecord(context, access, describe.name, id);
      const lines = [`Created ${describe.label} ${id} — ${recordUrl(access, id)}`];
      if (typeof after !== 'string') {
        const set = changeLines(describe, {}, after, Object.keys(prepared.values)).filter(
          (line) => !line.includes(': (blank) → (blank)')
        );
        lines.push(...set);
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_update_record',
    {
      title: 'Salesforce · Act — Update a record',
      description:
        'Change fields on one record of any object. Values are checked first (picklists for the ' +
        'record’s record type, dependent picklists against their controlling field, read-only and ' +
        'formula fields refused with why). The result shows old → new for each field, and what ' +
        'the org’s automation changed alongside. If someone saved the record in between, nothing ' +
        'is overwritten: read it again. To change many records use salesforce_update_records_preview.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField.optional().describe('The object; optional when the record is an id.'),
        record: recordField,
        fields: fieldsField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await resolveRef(context, access, args);
      if (typeof found === 'string') return errText(found);
      const { describe, id } = found;
      const before = await readRecord(context, access, describe.name, id);
      if (typeof before === 'string') return errText(before);
      const prepared = await prepareWrite(context, access, describe, args.fields, 'update', {
        recordTypeId: typeof before.RecordTypeId === 'string' ? before.RecordTypeId : null,
        current: before,
      });
      if (prepared.errors.length > 0) return errText(prepared.errors.join('\n'));
      if (Object.keys(prepared.values).length === 0) return errText('No fields to change.');
      const unmodifiedSince = httpDate(before.LastModifiedDate);
      const result = await sfRequest(
        context,
        access,
        'PATCH',
        `/sobjects/${encodeURIComponent(describe.name)}/${encodeURIComponent(id)}`,
        prepared.values,
        unmodifiedSince ? { 'If-Unmodified-Since': unmodifiedSince } : undefined
      );
      forgetSchemaOn(result, access, describe.name);
      if (!result.ok) return blocked(result, `update ${describe.label} ${found.name}`);
      const after = await readRecord(context, access, describe.name, id);
      return textResult(
        [
          `Updated ${describe.label} ${found.name} — ${recordUrl(access, id)}`,
          ...(typeof after === 'string'
            ? Object.keys(prepared.values).map((key) => `${key}: ${display(prepared.values[key])}`)
            : changeLines(describe, before, after, Object.keys(prepared.values))),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_upsert_record',
    {
      title: 'Salesforce · Act — Create or update by external id',
      description:
        'Create a record, or update the one already holding this external id value — for records ' +
        'that came from another system and carry its id in an external-id field.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        externalIdField: z.string().min(1).describe('The external-id field’s API name or label.'),
        externalId: z.string().min(1).describe('Its value.'),
        fields: fieldsField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const key = findByNameOrLabel(describe.fields, args.externalIdField);
      if (key.kind !== 'found' || !(key.value.externalId || key.value.idLookup)) {
        const options = describe.fields.filter((f) => f.externalId).map((f) => f.name);
        return errText(
          `${args.externalIdField} is not an external-id field of ${describe.name}${
            options.length ? `; its external-id fields are ${options.join(', ')}` : ''
          }.`
        );
      }
      const prepared = await prepareWrite(context, access, describe, args.fields, 'update');
      if (prepared.errors.length > 0) return errText(prepared.errors.join('\n'));
      const result = await sfRequest(
        context,
        access,
        'PATCH',
        `/sobjects/${encodeURIComponent(describe.name)}/${encodeURIComponent(key.value.name)}/${encodeURIComponent(args.externalId)}`,
        prepared.values
      );
      forgetSchemaOn(result, access, describe.name);
      if (!result.ok) return blocked(result, `save the ${describe.label}`);
      const body = rec(result.body);
      const id = str(body.id);
      return textResult(
        `${result.status === 201 || body.created === true ? 'Created' : 'Updated'} ${describe.label}` +
          `${id ? ` ${id} — ${recordUrl(access, id)}` : ` with ${key.value.name} ${args.externalId}`}`
      );
    }
  );

  server.registerTool(
    'salesforce_relate_records',
    {
      title: 'Salesforce · Act — Relate two records (many-to-many)',
      description:
        'Relate two records whose objects are joined by a junction object (a contact to a ' +
        'program, an account to a campaign) by creating the junction record between them. The ' +
        'junction is found from the org’s schema; when more than one joins them, name it.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        from: recordRefField,
        to: recordRefField,
        junctionObject: objectField
          .optional()
          .describe('The junction object, when more than one joins them.'),
        fields: fieldsField.optional().describe('Other fields to set on the junction record.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const from = await resolveRef(context, access, args.from);
      if (typeof from === 'string') return errText(from);
      const to = await resolveRef(context, access, args.to);
      if (typeof to === 'string') return errText(to);
      let junctions = findRelationshipPaths(from.describe, to.describe).filter(
        (path) => path.kind === 'junction'
      );
      if (args.junctionObject) {
        const wanted = await resolveObject(context, access, args.junctionObject);
        if (typeof wanted === 'string') return errText(wanted);
        junctions = junctions.filter(
          (path) => path.kind === 'junction' && path.junctionObject === wanted.name
        );
      }
      if (junctions.length === 0) {
        return errText(`No junction object joins ${from.describe.name} and ${to.describe.name}.`);
      }
      if (junctions.length > 1) {
        return errText(
          `More than one junction joins them: ${junctions
            .map((path) =>
              path.kind === 'junction'
                ? `${path.junctionObject} (${path.fromField}, ${path.toField})`
                : ''
            )
            .join('; ')}. Name junctionObject.`
        );
      }
      const path = junctions[0];
      if (path.kind !== 'junction') return errText('No junction object joins them.');
      const junction = await describeObject(context, access, path.junctionObject);
      if (typeof junction === 'string') return errText(junction);
      const prepared = await prepareWrite(
        context,
        access,
        junction,
        { ...(args.fields ?? {}), [path.fromField]: from.id, [path.toField]: to.id },
        'create'
      );
      if (prepared.errors.length > 0) return errText(prepared.errors.join('\n'));
      const result = await sfRequest(
        context,
        access,
        'POST',
        `/sobjects/${encodeURIComponent(junction.name)}`,
        prepared.values
      );
      if (!result.ok) return blocked(result, `relate ${from.name} and ${to.name}`);
      const id = str(rec(result.body).id);
      return textResult(
        `Related ${from.describe.label} ${from.name} and ${to.describe.label} ${to.name} through ${junction.label} ${id} — ${recordUrl(access, id)}`
      );
    }
  );

  /** WhoId (a contact or lead) and WhatId (anything else) for an activity. */
  async function activityTargets(
    access: SalesforceAccess,
    refs: { object?: string; record: string }[]
  ): Promise<{ WhoId?: string; WhatId?: string; names: string[] } | string> {
    const out: { WhoId?: string; WhatId?: string; names: string[] } = { names: [] };
    for (const ref of refs) {
      const found = await resolveRef(context, access, ref);
      if (typeof found === 'string') return found;
      const who = found.describe.name === 'Contact' || found.describe.name === 'Lead';
      if (who) {
        if (out.WhoId) return 'An activity relates to one contact or lead; name only one.';
        out.WhoId = found.id;
      } else {
        if (out.WhatId)
          return 'An activity relates to one record besides a contact or lead; name only one.';
        out.WhatId = found.id;
      }
      out.names.push(`${found.describe.label} ${found.name}`);
    }
    return out;
  }

  server.registerTool(
    'salesforce_log_activity',
    {
      title: 'Salesforce · Act — Log a call, email or meeting',
      description:
        'Log something that happened — a call, an email, a meeting, anything else — as a completed ' +
        'task on the records it was about (one contact or lead, and/or one other record of any ' +
        'object), so it shows in their activity history.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        kind: z.enum(['call', 'email', 'meeting', 'other']).describe('What it was.'),
        subject: z
          .string()
          .min(1)
          .max(255)
          .describe('The subject line ("Call with Jane re: renewal").'),
        notes: z.string().max(32000).optional().describe('What was said or decided.'),
        date: z.string().optional().describe('When, YYYY-MM-DD; default today.'),
        relatedTo: z.array(recordRefField).min(1).max(2).describe('The records it was about.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const targets = await activityTargets(access, args.relatedTo);
      if (typeof targets === 'string') return errText(targets);
      const task: Record<string, unknown> = {
        Subject: args.subject,
        Status: 'Completed',
        ActivityDate: args.date ?? new Date().toISOString().slice(0, 10),
        TaskSubtype: args.kind === 'call' ? 'Call' : args.kind === 'email' ? 'Email' : 'Task',
        ...(args.notes ? { Description: args.notes } : {}),
        ...(targets.WhoId ? { WhoId: targets.WhoId } : {}),
        ...(targets.WhatId ? { WhatId: targets.WhatId } : {}),
      };
      const result = await sfRequest(context, access, 'POST', '/sobjects/Task', task);
      if (!result.ok) return blocked(result, 'log the activity');
      const id = str(rec(result.body).id);
      return textResult(
        `Logged "${args.subject}" on ${targets.names.join(' and ')} — ${recordUrl(access, id)}`
      );
    }
  );

  server.registerTool(
    'salesforce_create_task',
    {
      title: 'Salesforce · Act — Create a follow-up task',
      description:
        'Create an open task — a follow-up for the person or a colleague — with a due date, on the ' +
        'records it is about.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        subject: z.string().min(1).max(255),
        due: z.string().optional().describe('Due date, YYYY-MM-DD.'),
        assignee: z
          .string()
          .optional()
          .describe('Who does it: "me" (default), a name, username or email.'),
        priority: z.enum(['High', 'Normal', 'Low']).optional(),
        notes: z.string().max(32000).optional(),
        relatedTo: z.array(recordRefField).max(2).optional(),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const owner = await resolveOwner(context, access, args.assignee ?? 'me', false);
      if (typeof owner === 'string') return errText(owner);
      const targets = await activityTargets(access, args.relatedTo ?? []);
      if (typeof targets === 'string') return errText(targets);
      const task: Record<string, unknown> = {
        Subject: args.subject,
        OwnerId: owner.id,
        ...(args.due ? { ActivityDate: args.due } : {}),
        ...(args.priority ? { Priority: args.priority } : {}),
        ...(args.notes ? { Description: args.notes } : {}),
        ...(targets.WhoId ? { WhoId: targets.WhoId } : {}),
        ...(targets.WhatId ? { WhatId: targets.WhatId } : {}),
      };
      const result = await sfRequest(context, access, 'POST', '/sobjects/Task', task);
      if (!result.ok) return blocked(result, 'create the task');
      const id = str(rec(result.body).id);
      return textResult(
        `Task "${args.subject}" for ${owner.name}${args.due ? `, due ${args.due}` : ''}` +
          `${targets.names.length ? ` on ${targets.names.join(' and ')}` : ''} — ${recordUrl(access, id)}`
      );
    }
  );

  server.registerTool(
    'salesforce_add_note',
    {
      title: 'Salesforce · Act — Add a note to a record',
      description:
        'Attach a note (title and text) to a record of any object, in its Notes related list.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField.optional().describe('The object; optional when the record is an id.'),
        record: recordField,
        title: z.string().min(1).max(255),
        text: z.string().min(1).max(100000),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const found = await resolveRef(context, access, args);
      if (typeof found === 'string') return errText(found);
      // ContentNote holds HTML; the text is escaped and its lines kept.
      const html = args.text
        .split('\n')
        .map(
          (line) =>
            `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
        )
        .join('');
      const note = await sfRequest(context, access, 'POST', '/sobjects/ContentNote', {
        Title: args.title,
        Content: Buffer.from(html, 'utf8').toString('base64'),
      });
      if (!note.ok) return blocked(note, 'create the note');
      const noteId = str(rec(note.body).id);
      const link = await sfRequest(context, access, 'POST', '/sobjects/ContentDocumentLink', {
        ContentDocumentId: noteId,
        LinkedEntityId: found.id,
        ShareType: 'V',
      });
      if (!link.ok) return blocked(link, `attach the note to ${found.name}`);
      return textResult(
        `Added note "${args.title}" to ${found.describe.label} ${found.name} — ${recordUrl(access, found.id)}`
      );
    }
  );
}

export { display };
