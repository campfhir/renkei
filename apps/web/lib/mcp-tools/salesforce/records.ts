/**
 * The salesforce_ read tools: who the connection is, the org's objects and
 * their fields, search and SOQL, a record with its parents and children,
 * related lists, how two objects connect, field history, and what changed
 * in a window. Every one runs as the person, so what their Salesforce user
 * cannot see does not come back.
 *
 * Long text fields (notes, descriptions over 255 characters) are left out
 * of a record's default view and returned only when asked for by name:
 * that is where unstructured, often sensitive detail ends up
 * (docs/salesforce-connectors-design.md, "Health and other sensitive records").
 *
 * What the connector keeps away from the model (policy.ts) never comes
 * back: describes are filtered in schema.ts, and model-written SOQL, search
 * hits and whole-record reads go through the policy's query helpers.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  checkSelectQuery,
  findByNameOrLabel,
  findRelationshipPaths,
  isEmptyPolicy,
  isSalesforceId,
  isSoqlIdentifier,
  isSystemObject,
  nameFieldOf,
  sortObjectsForListing,
  soqlString,
  summarizeDescribe,
  to18,
  type DescribeSObject,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from './salesforce-auth';
import {
  apiUsage,
  readAccess,
  errText,
  json,
  rec,
  recordUrl,
  recs,
  sfGet,
  sfQuery,
  str,
  strings,
  textResult,
  type SalesforceAccess,
} from './client';
import {
  describeObject,
  globalDescribe,
  objectOfId,
  recordTypePicklists,
  resolveObject,
  resolveRecord,
  resolveRecordType,
} from './schema';
import { limitField, objectField, recordField } from './fields';
import { hiddenFields, scrubbed, sfQueryPolicy } from './policy';

/** A long text area: kept out of a record's default view (see the header). */
export function isLongText(describe: DescribeSObject, field: string): boolean {
  const meta = describe.fields.find((f) => f.name === field);
  return meta?.type === 'textarea' && (meta.length ?? 0) > 255;
}

/** Fields Salesforce maintains that say nothing about the record. */
export const SYSTEM_FIELDS = new Set([
  'SystemModstamp',
  'LastModifiedDate',
  'LastModifiedById',
  'LastViewedDate',
  'LastReferencedDate',
  'IsDeleted',
]);

/** The object and id of a { object?, record } reference. */
export async function resolveRef(
  context: MCPToolContext,
  access: SalesforceAccess,
  ref: { object?: string; record: string }
): Promise<{ describe: DescribeSObject; id: string; name: string } | string> {
  if (!ref.object) {
    if (!isSalesforceId(ref.record.trim())) {
      return `"${ref.record}" is not an id; say which object it is ({ object, record }).`;
    }
    const describe = await objectOfId(context, access, ref.record.trim());
    if (typeof describe === 'string') return describe;
    const found = await resolveRecord(context, access, describe, ref.record);
    return typeof found === 'string' ? found : { describe, ...found };
  }
  const describe = await resolveObject(context, access, ref.object);
  if (typeof describe === 'string') return describe;
  const found = await resolveRecord(context, access, describe, ref.record);
  return typeof found === 'string' ? found : { describe, ...found };
}

export function registerRecordReadTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_check_access',
    {
      title: 'Salesforce · Read — Who is this connection?',
      description:
        'Who the Salesforce connection acts as (user, profile, role), which org (and whether it ' +
        'is a sandbox), what this connection may do in Renkei, and how much of the org’s daily ' +
        'API allowance is used. Call this first when calls are refused.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      // Answers even over budget: it is how a person sees the usage.
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const [user, org, limits] = await Promise.all([
        sfQuery(
          context,
          access,
          `SELECT Name, Username, Email, Profile.Name, UserRole.Name FROM User WHERE Id = ${soqlString(to18(access.userId))}`
        ),
        sfQuery(
          context,
          access,
          'SELECT Name, IsSandbox, OrganizationType, InstanceName FROM Organization'
        ),
        sfGet(context, access, '/limits'),
      ]);
      if (!user.ok) return errText(user.error);
      const me = user.records[0] ?? {};
      const organization = org.ok ? (org.records[0] ?? {}) : {};
      const daily = limits.ok ? rec(rec(limits.body).DailyApiRequests) : {};
      const max = typeof daily.Max === 'number' ? daily.Max : null;
      const remaining = typeof daily.Remaining === 'number' ? daily.Remaining : null;
      const seen = apiUsage(access.orgId);
      const usage =
        max !== null && remaining !== null
          ? `${(max - remaining).toLocaleString('en-US')} of ${max.toLocaleString('en-US')}`
          : seen
            ? `${seen.used.toLocaleString('en-US')} of ${seen.max.toLocaleString('en-US')}`
            : 'unknown';
      const capabilities = context.salesforceScopes ?? [];
      return textResult(
        [
          `Connected as ${str(me.Name) || access.username} (${str(me.Username) || access.username})`,
          `Profile: ${str(rec(me.Profile).Name) || 'unknown'}; role: ${str(rec(me.UserRole).Name) || 'none'}`,
          `Org: ${str(organization.Name) || access.orgId} (${access.orgId})` +
            (organization.IsSandbox === true ? ' — a sandbox' : '') +
            (str(organization.OrganizationType) ? `, ${str(organization.OrganizationType)}` : ''),
          `Org address: ${access.instanceUrl}`,
          `Daily API calls used: ${usage} (shared by every integration in the org; reads pause at 80%)`,
          `This connection may: ${capabilities.length ? capabilities.join(', ') : 'nothing'}`,
          'Salesforce applies your own object, field and sharing access to every call.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_list_objects',
    {
      title: 'Salesforce · Read — List objects',
      description:
        'The objects visible to the person — the org’s own custom objects first, then managed ' +
        'packages’, then standard ones — with API names and labels. Filter by text or to custom ' +
        'objects only. Use the API name in the other tools.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z.string().optional().describe('Only objects whose name or label contains this.'),
        customOnly: z.boolean().optional().describe('Only custom objects.'),
        limit: limitField(500, 150),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const objects = await globalDescribe(context, access);
      if (typeof objects === 'string') return errText(objects);
      const wanted = (args.search ?? '').toLowerCase();
      const listed = sortObjectsForListing(
        objects.filter(
          (o) =>
            o.queryable &&
            !o.deprecatedAndHidden &&
            !isSystemObject(o.name) &&
            (!args.customOnly || o.custom) &&
            (!wanted ||
              o.name.toLowerCase().includes(wanted) ||
              o.label.toLowerCase().includes(wanted))
        )
      );
      const limit = args.limit ?? 150;
      const lines = listed
        .slice(0, limit)
        .map((o) => `${o.name} — ${o.label}${o.custom ? ' (custom)' : ''}`);
      if (listed.length > limit)
        lines.push(`…and ${listed.length - limit} more; narrow with search.`);
      return textResult(lines.length ? lines.join('\n') : 'No objects match.');
    }
  );

  server.registerTool(
    'salesforce_describe_object',
    {
      title: 'Salesforce · Read — Describe an object',
      description:
        'An object’s fields — type, required, read-only, picklist values (for a record type when ' +
        'given), lookups and what they point at, help text the org wrote — its record types and ' +
        'its child relationships. Read this before writing to or querying an object you have not ' +
        'used yet; the help text says what a custom field means.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField,
        recordType: z
          .string()
          .optional()
          .describe('A record type name or id, to show only its picklist values.'),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const summary = summarizeDescribe(describe);
      if (args.recordType) {
        const recordTypeId = resolveRecordType(describe, args.recordType);
        if (typeof recordTypeId !== 'string') return errText(recordTypeId.error);
        const picklists = await recordTypePicklists(context, access, describe.name, recordTypeId);
        if (picklists) summary.recordTypePicklists = picklists;
      }
      return textResult(json(summary));
    }
  );

  server.registerTool(
    'salesforce_search',
    {
      title: 'Salesforce · Read — Search records',
      description:
        'Find records by text across the org (“everything about Acme”), or within named objects ' +
        '— names, emails, phone numbers and other searchable text. For exact filters, counts or ' +
        'sorting use salesforce_query.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        text: z.string().min(2).describe('What to search for (at least two characters).'),
        objects: z
          .array(objectField)
          .max(10)
          .optional()
          .describe('Only these objects; default is the org’s usual searchable objects.'),
        limit: limitField(50, 20),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const limit = args.limit ?? 20;
      const params = new URLSearchParams({ q: args.text, overallLimit: String(limit) });
      for (const name of args.objects ?? []) {
        const describe = await resolveObject(context, access, name);
        if (typeof describe === 'string') return errText(describe);
        const nameField = nameFieldOf(describe);
        params.append('sobject', describe.name);
        params.set(
          `${describe.name}.fields`,
          ['Id', ...(nameField ? [nameField.name] : [])].join(',')
        );
      }
      const result = await sfGet(context, access, `/parameterizedSearch/?${params.toString()}`);
      if (!result.ok) return errText(result.error);
      const hits = await scrubbed(context, access, recs(rec(result.body).searchRecords));
      if (typeof hits === 'string') return errText(hits);
      if (hits.length === 0) return textResult(`Nothing matches "${args.text}".`);
      const lines = hits.map((hit) => {
        const type = str(rec(hit.attributes).type);
        const label = str(hit.Name) || str(hit.Subject) || str(hit.CaseNumber) || str(hit.Title);
        return `${type} ${str(hit.Id)}${label ? ` — ${label}` : ''}`;
      });
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_query',
    {
      title: 'Salesforce · Read — Run a SOQL query',
      description:
        'Run one SOQL SELECT — filters, relationship fields (Account.Name), child subqueries, ' +
        'aggregates (COUNT, SUM, GROUP BY), ORDER BY. A LIMIT is added when the query has none. ' +
        'Pass the cursor a result returns to read the next page. Build field and object names ' +
        'from salesforce_describe_object; use date literals (THIS_QUARTER, LAST_N_DAYS:14).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        soql: z.string().optional().describe('The SELECT query.'),
        cursor: z
          .string()
          .optional()
          .describe('The cursor a previous page returned, instead of soql.'),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      let target: string;
      let note = '';
      if (args.cursor) {
        if (!/^\/services\/data\/v[\d.]+\/query\/[A-Za-z0-9-]+$/.test(args.cursor)) {
          return errText('That is not a cursor this tool returned.');
        }
        target = args.cursor;
      } else if (args.soql) {
        const checked = checkSelectQuery(args.soql, 200);
        if (!checked.ok) return errText(checked.error);
        target = checked.value.query;
        if (checked.value.limited) note = ' (LIMIT 200 added)';
      } else {
        return errText('Give a SOQL query, or a cursor from a previous page.');
      }
      const page = await sfQueryPolicy(context, access, target);
      if (!page.ok) return errText(page.error);
      return textResult(
        [
          `${page.records.length} of ${page.totalSize} row${page.totalSize === 1 ? '' : 's'}${note}` +
            (page.next ? ` — more: call again with cursor ${page.next}` : ''),
          json(page.records),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_get_record',
    {
      title: 'Salesforce · Read — Get a record',
      description:
        'One record, any object: its fields (all of them by default; long text fields only when ' +
        'named), optionally parent fields by path (Account.Owner.Name) and child records by ' +
        'relationship name (Contacts, Site_Visits__r) in the same call, and a link to open it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField.optional().describe('The object; optional when the record is an id.'),
        record: recordField,
        fields: z
          .array(z.string())
          .max(100)
          .optional()
          .describe(
            'Only these fields (API names or relationship paths); long text fields must be named here to be read.'
          ),
        children: z
          .array(z.string())
          .max(10)
          .optional()
          .describe(
            'Child relationship names to include, newest first, 10 each (salesforce_describe_object lists them).'
          ),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const found = await resolveRef(context, access, args);
      if (typeof found === 'string') return errText(found);
      const { describe, id } = found;

      const named = (args.fields ?? []).map((f) => f.trim()).filter(Boolean);
      const bad = named.filter((f) => !isSoqlIdentifier(f));
      if (bad.length > 0) return errText(`Not field names: ${bad.join(', ')}`);
      // FIELDS(ALL) would bring back what the connector hides; with a
      // policy in force, the (filtered) describe's fields are named instead.
      const select =
        named.length > 0
          ? ['Id', ...named.filter((f) => f !== 'Id')]
          : isEmptyPolicy(access.policy)
            ? ['FIELDS(ALL)']
            : describe.fields.map((field) => field.name);
      const relationships = [];
      for (const relationship of args.children ?? []) {
        const rel = (describe.childRelationships ?? []).find(
          (candidate) => candidate.relationshipName?.toLowerCase() === relationship.toLowerCase()
        );
        if (!rel?.relationshipName) {
          return errText(
            `${describe.name} has no child relationship "${relationship}". salesforce_describe_object lists them.`
          );
        }
        relationships.push(rel);
      }
      const result = await sfQueryPolicy(
        context,
        access,
        `SELECT ${select.join(', ')} FROM ${describe.name} WHERE Id = ${soqlString(id)} LIMIT 1`
      );
      if (!result.ok) return errText(result.error);
      const record = result.records[0];
      if (!record) return errText(`No ${describe.label} ${id} is visible to your Salesforce user.`);
      // Children one query each, from the child object: FIELDS(ALL) above
      // and subqueries are kept apart rather than combined.
      const children: Record<string, unknown> = {};
      for (const rel of relationships) {
        const child = await describeObject(context, access, rel.childSObject);
        const childName = typeof child === 'string' ? null : nameFieldOf(child);
        const page = await sfQuery(
          context,
          access,
          `SELECT Id${childName ? `, ${childName.name}` : ''}, CreatedDate FROM ${rel.childSObject} WHERE ${rel.field} = ${soqlString(id)} ORDER BY CreatedDate DESC LIMIT 10`
        );
        children[rel.relationshipName ?? rel.childSObject] = page.ok
          ? { totalSize: page.totalSize, newest: page.records }
          : { error: page.error };
      }
      const omitted: string[] = [];
      const shown: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (named.length === 0 && isLongText(describe, key)) {
          if (value !== null) omitted.push(key);
          continue;
        }
        if (named.length === 0 && (value === null || SYSTEM_FIELDS.has(key))) continue;
        shown[key] = value;
      }
      return textResult(
        [
          `${describe.label} ${found.name} — ${recordUrl(access, id)}`,
          json(relationships.length > 0 ? { ...shown, related: children } : shown),
          ...(omitted.length
            ? [`Long text fields not shown (name them in fields to read): ${omitted.join(', ')}`]
            : []),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_list_related',
    {
      title: 'Salesforce · Read — List related records',
      description:
        'The records in one of a record’s related lists — any child relationship, standard or ' +
        'custom (a contact’s Opportunities, an account’s Site_Visits__r) — newest first, paged.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField
          .optional()
          .describe('The parent’s object; optional when the record is an id.'),
        record: recordField,
        relationship: z
          .string()
          .min(1)
          .describe(
            'The child relationship name (Contacts, Site_Visits__r) or the child object (Contact).'
          ),
        fields: z.array(z.string()).max(30).optional().describe('Extra child fields to include.'),
        limit: limitField(200, 25),
        cursor: z.string().optional().describe('The cursor a previous page returned.'),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      if (args.cursor) {
        if (!/^\/services\/data\/v[\d.]+\/query\/[A-Za-z0-9-]+$/.test(args.cursor)) {
          return errText('That is not a cursor this tool returned.');
        }
        const page = await sfQueryPolicy(context, access, args.cursor);
        if (!page.ok) return errText(page.error);
        return textResult(
          [
            `${page.records.length} more${page.next ? ` — more: cursor ${page.next}` : ''}`,
            json(page.records),
          ].join('\n')
        );
      }
      const parent = await resolveRef(context, access, args);
      if (typeof parent === 'string') return errText(parent);
      const wanted = args.relationship.toLowerCase();
      const matches = (parent.describe.childRelationships ?? []).filter(
        (rel) =>
          rel.relationshipName &&
          (rel.relationshipName.toLowerCase() === wanted ||
            rel.childSObject.toLowerCase() === wanted)
      );
      if (matches.length === 0) {
        return errText(`${parent.describe.name} has no related list "${args.relationship}".`);
      }
      if (matches.length > 1) {
        return errText(
          `${args.relationship} relates to ${parent.describe.name} more than one way: ${matches
            .map((rel) => `${rel.relationshipName} (${rel.childSObject}.${rel.field})`)
            .join(', ')}. Name the relationship.`
        );
      }
      const rel = matches[0];
      const child = await describeObject(context, access, rel.childSObject);
      if (typeof child === 'string') return errText(child);
      const extra = (args.fields ?? []).filter((f) => isSoqlIdentifier(f));
      const nameField = nameFieldOf(child);
      const select = [
        ...new Set(['Id', ...(nameField ? [nameField.name] : []), ...extra, 'CreatedDate']),
      ];
      const page = await sfQueryPolicy(
        context,
        access,
        `SELECT ${select.join(', ')} FROM ${child.name} WHERE ${rel.field} = ${soqlString(parent.id)} ORDER BY CreatedDate DESC LIMIT ${args.limit ?? 25}`
      );
      if (!page.ok) return errText(page.error);
      return textResult(
        [
          `${page.records.length} of ${page.totalSize} ${child.labelPlural ?? child.label} on ${parent.describe.label} ${parent.name}` +
            (page.next ? ` — more: cursor ${page.next}` : ''),
          json(page.records),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_find_relationship_path',
    {
      title: 'Salesforce · Read — How do two objects connect?',
      description:
        'How two objects relate in this org — a lookup or master-detail either way, a junction ' +
        'object between them (many-to-many), or a parent they share — with the field and ' +
        'relationship names to query by. Use before querying across objects you have not joined before.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ from: objectField, to: objectField }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const from = await resolveObject(context, access, args.from);
      if (typeof from === 'string') return errText(from);
      const to = await resolveObject(context, access, args.to);
      if (typeof to === 'string') return errText(to);
      const paths = findRelationshipPaths(from, to);
      if (paths.length === 0) {
        return textResult(
          `${from.name} and ${to.name} are not related directly, through a junction object, or through a shared parent.`
        );
      }
      return textResult(paths.map((path) => `• ${path.description}`).join('\n'));
    }
  );

  server.registerTool(
    'salesforce_record_history',
    {
      title: 'Salesforce · Read — Field history of a record',
      description:
        'Who changed which tracked field of a record, from what to what, and when — from the ' +
        'object’s field history (only fields the org tracks; Salesforce keeps standard history ' +
        'for 18 months).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField.optional().describe('The object; optional when the record is an id.'),
        record: recordField,
        limit: limitField(200, 50),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const found = await resolveRef(context, access, args);
      if (typeof found === 'string') return errText(found);
      const { describe } = found;
      const custom = describe.name.endsWith('__c');
      const table = custom
        ? describe.name.replace(/__c$/, '__History')
        : describe.name === 'Opportunity'
          ? 'OpportunityFieldHistory'
          : `${describe.name}History`;
      const parentField = custom ? 'ParentId' : `${describe.name}Id`;
      const objects = await globalDescribe(context, access);
      if (typeof objects === 'string') return errText(objects);
      if (!objects.some((o) => o.name === table)) {
        return textResult(`Field history is not tracked for ${describe.label} in this org.`);
      }
      const page = await sfQuery(
        context,
        access,
        `SELECT Field, OldValue, NewValue, CreatedDate, CreatedBy.Name FROM ${table} WHERE ${parentField} = ${soqlString(found.id)} ORDER BY CreatedDate DESC LIMIT ${args.limit ?? 50}`
      );
      if (!page.ok) return errText(page.error);
      // A hidden field's history is as hidden as its value.
      const hidden = await hiddenFields(context, access, describe.name);
      if (typeof hidden === 'string') return errText(hidden);
      const rows = page.records.filter((row) => !hidden.has(str(row.Field).toLowerCase()));
      if (rows.length === 0)
        return textResult(`No tracked changes on ${describe.label} ${found.name}.`);
      const label = (field: string) =>
        describe.fields.find((f) => f.name === field)?.label ?? field;
      return textResult(
        rows
          .map(
            (row) =>
              `${str(row.CreatedDate)} — ${str(rec(row.CreatedBy).Name) || 'someone'}: ${label(str(row.Field))} ` +
              `${row.OldValue === null || row.OldValue === undefined ? '' : `from "${str(row.OldValue)}" `}to "${str(row.NewValue)}"`
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'salesforce_list_changes',
    {
      title: 'Salesforce · Read — What changed on an object',
      description:
        'Records of one object updated, or deleted, between two times (“what changed on site ' +
        'visits since Monday”), with their names. Salesforce answers for roughly the last 30 days.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField,
        since: z.string().describe('Start, ISO 8601 (2026-10-19T00:00:00Z).'),
        until: z.string().optional().describe('End, ISO 8601; default now.'),
        deleted: z.boolean().optional().describe('Deleted records instead of updated ones.'),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const start = new Date(args.since);
      const end = args.until ? new Date(args.until) : new Date();
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return errText('since and until must be ISO 8601 date-times.');
      }
      const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const kind = args.deleted ? 'deleted' : 'updated';
      const result = await sfGet(
        context,
        access,
        `/sobjects/${encodeURIComponent(describe.name)}/${kind}/?start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`
      );
      if (!result.ok) return errText(result.error);
      const body = rec(result.body);
      if (args.deleted) {
        const rows = recs(body.deletedRecords);
        if (rows.length === 0)
          return textResult(`No ${describe.labelPlural ?? describe.label} deleted in that window.`);
        return textResult(
          rows.map((row) => `${str(row.id)} deleted ${str(row.deletedDate)}`).join('\n')
        );
      }
      const ids = strings(body.ids);
      if (ids.length === 0)
        return textResult(`No ${describe.labelPlural ?? describe.label} changed in that window.`);
      const nameField = nameFieldOf(describe);
      const names = new Map<string, string>();
      if (nameField) {
        const page = await sfQuery(
          context,
          access,
          `SELECT Id, ${nameField.name}, LastModifiedDate, LastModifiedBy.Name FROM ${describe.name} WHERE Id IN (${ids
            .slice(0, 200)
            .map(soqlString)
            .join(', ')})`
        );
        if (page.ok) {
          for (const row of page.records) {
            names.set(
              str(row.Id),
              `${str(row[nameField.name])} — ${str(row.LastModifiedDate)} by ${str(rec(row.LastModifiedBy).Name)}`
            );
          }
        }
      }
      return textResult(
        [
          `${ids.length} ${describe.labelPlural ?? describe.label} changed:`,
          ...ids.slice(0, 200).map((id) => `${id}${names.has(id) ? ` — ${names.get(id)}` : ''}`),
          ...(ids.length > 200 ? [`…and ${ids.length - 200} more.`] : []),
        ].join('\n')
      );
    }
  );
}

/** Used by the write tools: a field of `describe` by API name or label, or an error. */
export function fieldOf(describe: DescribeSObject, input: string) {
  return findByNameOrLabel(describe.fields, input);
}
