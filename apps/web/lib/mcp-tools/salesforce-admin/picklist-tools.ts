/**
 * Picklists, wherever their values live: a custom field's own values, a
 * global value set (every field on it changes together), or a standard
 * value set (Lead Source, Industry, Stage… — some shared by several
 * objects' fields). Reading one shows its values, active or not, and what
 * each record type offers; a proposal changes the values, and which record
 * types offer them — for Stage and the Status fields, through each record
 * type's business process, which is where Salesforce keeps those.
 *
 * Every part is read whole and written back whole with only the change
 * merged in (@renkei/connector-salesforce picklists.ts), each guarded by a
 * hash of what was read; values are never deleted.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  existingFieldXml,
  fieldsOfValueSet,
  FORECAST_CATEGORIES,
  mergeBusinessProcessValues,
  mergeGlobalValueSetChanges,
  mergePicklistChanges,
  mergeRecordTypePicklist,
  mergeStandardValueSetChanges,
  metadataFile,
  objectChildXml,
  processOf,
  recordTypePicklists,
  soqlString,
  standardValueSetOf,
  type AvailabilityChange,
  type PicklistChanges,
  type ValueRow,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, rec, recs, str, textResult, type SalesforceAccess } from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import {
  PICKLIST_CHANGES_KIND,
  readCustomField,
  toolingQuery,
  type LiveCustomField,
} from '@/lib/salesforce-admin/plan';
import {
  findRecordType,
  listRecordTypes,
  readBusinessProcess,
  readGlobalValueSet,
  readRecordType,
  readStandardValueSet,
  type LiveGlobalValueSet,
  type LiveStandardValueSet,
  type RecordTypeRef,
} from '@/lib/salesforce-admin/whole-components';
import { PackageBuilder } from './package-builder';
import { rowLine } from './propose-changes';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

type Json = Record<string, unknown>;

/** Where a picklist's values live, as read. */
type Target =
  | { source: 'local'; object: string; label: string; field: string; live: LiveCustomField }
  | { source: 'global'; object?: string; label?: string; field?: string; set: LiveGlobalValueSet }
  | {
      source: 'standard';
      object: string;
      label: string;
      field: string;
      set: LiveStandardValueSet;
    };

const PICKLIST_TYPES = new Set(['picklist', 'multipicklist']);

/** The picklist named, or why not. */
async function resolvePicklist(
  context: MCPToolContext,
  access: SalesforceAccess,
  input: { object?: string; field?: string; valueSet?: string }
): Promise<Target | string> {
  if (!input.field) {
    if (!input.valueSet) return 'Name the picklist: object and field, or a global valueSet.';
    if (input.object) return 'With object, name the field too.';
    const set = await readGlobalValueSet(context, access, input.valueSet.trim());
    if (typeof set === 'string') return set;
    if (!set) return `No global value set ${input.valueSet} in this org.`;
    return { source: 'global', set };
  }
  if (!input.object) return 'Name the object the field is on.';
  const describe = await resolveObject(context, access, input.object);
  if (typeof describe === 'string') return describe;
  const field = describe.fields.find(
    (f) => f.name.toLowerCase() === input.field?.trim().toLowerCase()
  );
  if (!field) return `${describe.name} has no field ${input.field} that you can see.`;
  if (!PICKLIST_TYPES.has(field.type)) return `${describe.name}.${field.name} is not a picklist.`;
  const where = { object: describe.name, label: describe.label, field: field.name };

  if (!field.custom) {
    const setName = standardValueSetOf(describe.name, field.name);
    if (!setName) {
      return `${describe.name}.${field.name} is a standard picklist whose values Salesforce manages; they are not changed here.`;
    }
    const set = await readStandardValueSet(context, access, setName, describe.name, field.name);
    if (typeof set === 'string') return set;
    return { source: 'standard', ...where, set };
  }
  const live = await readCustomField(context, access, describe.name, field.name);
  if (typeof live === 'string') return live;
  if (!live) return `${describe.name} has no custom field ${field.name}.`;
  const shared = str(rec(live.metadata.valueSet).valueSetName);
  if (shared) {
    const set = await readGlobalValueSet(context, access, shared);
    if (typeof set === 'string') return set;
    if (!set)
      return `${describe.name}.${field.name} uses the global value set ${shared}, which could not be read.`;
    return { source: 'global', ...where, set };
  }
  return { source: 'local', ...where, live };
}

/** Each value as metadata holds it: name, label, default, active. */
function valueEntries(target: Target): Json[] {
  switch (target.source) {
    case 'local':
      return recs(rec(rec(target.live.metadata.valueSet).valueSetDefinition).value);
    case 'global':
      return recs(target.set.metadata.customValue);
    case 'standard':
      return target.set.values.map((v) => ({
        fullName: v.value,
        label: v.label,
        default: v.default,
        ...(v.flags ?? {}),
      }));
  }
}

const valueNames = (entries: Json[]) =>
  entries
    .filter((v) => v.isActive !== false)
    .map((v) => str(v.fullName))
    .filter(Boolean);

/** Where the values live, in words, with what else changes with them. */
async function sourceLine(
  context: MCPToolContext,
  access: SalesforceAccess,
  target: Target
): Promise<string> {
  switch (target.source) {
    case 'local':
      return `${target.object}.${target.field} has its own values.`;
    case 'standard': {
      const others = fieldsOfValueSet(target.set.set).filter(
        (f) => f.toLowerCase() !== `${target.object}.${target.field}`.toLowerCase()
      );
      return `${target.object}.${target.field} takes its values from the standard value set ${target.set.set}${others.length ? `, which ${others.join(', ')} also use — a change here changes them too` : ''}.`;
    }
    case 'global': {
      const users = await toolingQuery(
        context,
        access,
        `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = ${soqlString(target.set.id)} AND MetadataComponentType = 'CustomField'`
      );
      const fields = users.ok ? users.records.map((r) => str(r.MetadataComponentName)) : [];
      return `${target.field ? `${target.object}.${target.field} uses` : 'This is'} the global value set ${target.set.name} (“${target.set.label}”)${
        fields.length ? `, used by ${fields.join(', ')}` : ''
      } — a change to its values changes every field on it.`;
    }
  }
}

function valueLine(entry: Json): string {
  const name = str(entry.fullName);
  const label = str(entry.label);
  const flags = [
    entry.default === true && 'default',
    entry.isActive === false && 'inactive',
    typeof entry.probability === 'number' && `${entry.probability}%`,
    str(entry.forecastCategory) && `forecast ${str(entry.forecastCategory)}`,
    entry.won === true ? 'won' : entry.closed === true && 'closed',
    entry.converted === true && 'converted',
    entry.highPriority === true && 'high priority',
  ].filter(Boolean);
  return `• ${name}${label && label !== name ? ` — shown as “${label}”` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

const addField = z.object({
  value: z.string().min(1).max(255),
  label: z.string().optional().describe('What people see, when not the value itself.'),
  probability: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Opportunity Stage: required there.'),
  forecastCategory: z
    .enum(FORECAST_CATEGORIES)
    .optional()
    .describe('Opportunity Stage: required there.'),
  closed: z.boolean().optional().describe('Opportunity Stage, Case and Task Status.'),
  won: z.boolean().optional().describe('Opportunity Stage (a won stage is closed).'),
  converted: z.boolean().optional().describe('Lead Status.'),
  highPriority: z.boolean().optional().describe('Task Priority.'),
});

export function registerAdminPicklistTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_get_picklist',
    {
      title: 'Salesforce Admin · Read — A picklist’s values',
      description:
        'A picklist’s values, active and inactive, with labels and the default; where they live ' +
        '(the field’s own, a global value set and the fields that share it, or a standard value ' +
        'set such as Lead Source or Stage, with the other fields on it); and what each record ' +
        'type offers — for Stage and the Status fields, each record type’s business process. ' +
        'Name object and field, or a global value set alone.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: z.string().optional().describe('The object’s API name or label.'),
        field: z.string().optional().describe('The picklist field’s API name.'),
        valueSet: z.string().optional().describe('A global value set’s API name, alone.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const target = await resolvePicklist(context, access, args);
      if (typeof target === 'string') return errText(target);
      const lines = [await sourceLine(context, access, target), '', 'Values:'];
      lines.push(...valueEntries(target).map(valueLine));
      if (target.object && target.field) {
        lines.push('', ...(await availabilityLines(context, access, target.object, target.field)));
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_admin_propose_picklist_changes',
    {
      title: 'Salesforce Admin · Act — Propose picklist value changes',
      description:
        'Propose changes to a picklist’s values — custom or standard (Lead Source, Industry, ' +
        'Stage, Lead/Case/Task Status…), or a global value set — and to which values each record ' +
        'type offers. Add values (a new Stage needs its probability and forecast category), ' +
        'relabel them, stop offering or offer again (values are never deleted; records keep ' +
        'them), reorder, set the default. New values are offered on every record type that lists ' +
        'the picklist unless addToRecordTypes is false; recordTypes adjusts one record type ' +
        '(Stage and the Status fields: its business process). Checked by a validation deploy ' +
        'that changes nothing; the person reviews and applies it from the link this returns. ' +
        'Read it first: salesforce_admin_get_picklist.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: z.string().optional().describe('The object’s API name or label.'),
        field: z.string().optional().describe('The picklist field’s API name.'),
        valueSet: z
          .string()
          .optional()
          .describe('A global value set’s API name, to change it without naming a field.'),
        add: z.array(addField).max(200).optional(),
        relabel: z
          .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
          .max(200)
          .optional()
          .describe('New labels; the values records hold do not change.'),
        deactivate: z.array(z.string().min(1)).max(200).optional(),
        activate: z.array(z.string().min(1)).max(200).optional(),
        order: z
          .array(z.string().min(1))
          .max(1000)
          .optional()
          .describe('Values in their new order; values not named follow in their current order.'),
        defaultValue: z.string().optional().describe('The default value; "" for none.'),
        addToRecordTypes: z
          .boolean()
          .optional()
          .describe(
            'Offer added values on every record type that lists this picklist (default true).'
          ),
        recordTypes: z
          .array(
            z.object({
              recordType: z.string().min(1).describe('Its API name or label.'),
              add: z.array(z.string().min(1)).optional().describe('Values to offer there.'),
              remove: z
                .array(z.string().min(1))
                .optional()
                .describe('Values to stop offering there (they stay on the picklist).'),
              default: z
                .string()
                .optional()
                .describe('Its default for this picklist; "" for none.'),
            })
          )
          .max(50)
          .optional()
          .describe('What a record type offers of this picklist.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const target = await resolvePicklist(context, access, args);
      if (typeof target === 'string') return errText(target);
      if ((args.recordTypes ?? []).length > 0 && !target.object) {
        return errText('Record types belong to an object: name the object and field.');
      }

      const changes: PicklistChanges = {
        add: args.add,
        relabel: args.relabel,
        deactivate: args.deactivate,
        activate: args.activate,
        order: args.order,
        defaultValue: args.defaultValue,
      };
      const changesValues = Object.values(changes).some((v) => v !== undefined);
      if (!changesValues && (args.recordTypes ?? []).length === 0) {
        return errText(
          'Nothing was proposed: say which values to change, or what record types offer.'
        );
      }

      const built = new PackageBuilder();
      const summary: string[] = [];
      let known = valueNames(valueEntries(target));
      const errors: string[] = [];
      const name =
        target.source === 'global' && !target.field
          ? target.set.name
          : `${target.object}.${target.field}`;

      if (changesValues) {
        const rows = applyValueChanges(target, changes, built, errors);
        if (rows) {
          known = valueNames(valueEntries(target));
          summary.push(await sourceLine(context, access, target), ...rows.map(rowLine));
        }
      }

      if (target.object && target.field && errors.length === 0) {
        const added = (args.add ?? []).map((a) => a.value.trim());
        const lines = await planAvailability(context, access, {
          object: target.object,
          field: target.field,
          known,
          addEverywhere: args.addToRecordTypes === false ? [] : added,
          // A value no longer offered on the picklist is no longer offered anywhere.
          removeEverywhere: args.deactivate ?? [],
          perType: args.recordTypes ?? [],
          built,
          errors,
        });
        summary.push(...lines);
      }
      if (errors.length > 0)
        return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);
      return proposeAndValidate(context, access, {
        kind: PICKLIST_CHANGES_KIND,
        title: `${target.label ?? 'Global value set'}: change the values of ${name}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: built.build(),
        summary,
      });
    }
  );
}

/**
 * The value change merged into where the values live, added to the
 * package; the rows, or null with the errors pushed. The target's read
 * metadata is replaced by the merged one, so what record types may offer
 * includes the new values.
 */
function applyValueChanges(
  target: Target,
  changes: PicklistChanges,
  built: PackageBuilder,
  errors: string[]
): ValueRow[] | null {
  switch (target.source) {
    case 'local': {
      const merged = mergePicklistChanges(target.live.metadata, changes);
      if (!merged.ok) {
        errors.push(...merged.errors);
        return null;
      }
      const field = target.live.fullName.split('.').pop() ?? target.field;
      built.objectChild(target.object, existingFieldXml(field, merged.metadata), {
        type: 'CustomField',
        member: `${target.object}.${field}`,
      });
      built.components.push({
        type: 'CustomField',
        name: `${target.object}.${field}`,
        action: 'update',
        rows: merged.rows,
      });
      built.preconditions.push({
        kind: 'field-unchanged',
        object: target.object,
        field,
        fingerprint: target.live.fingerprint,
      });
      target.live = { ...target.live, metadata: merged.metadata };
      return merged.rows;
    }
    case 'global': {
      const merged = mergeGlobalValueSetChanges(target.set.metadata, changes);
      if (!merged.ok) {
        errors.push(...merged.errors);
        return null;
      }
      built.file(
        `globalValueSets/${target.set.name}.globalValueSet`,
        metadataFile('GlobalValueSet', merged.metadata),
        { type: 'GlobalValueSet', member: target.set.name }
      );
      built.components.push({
        type: 'GlobalValueSet',
        name: target.set.name,
        action: 'update',
        rows: merged.rows,
      });
      built.preconditions.push({
        kind: 'component-unchanged',
        type: 'GlobalValueSet',
        object: '',
        name: target.set.name,
        fingerprint: target.set.fingerprint,
      });
      target.set = { ...target.set, metadata: merged.metadata };
      return merged.rows;
    }
    case 'standard': {
      const merged = mergeStandardValueSetChanges(target.set.set, target.set.values, changes);
      if (!merged.ok) {
        errors.push(...merged.errors);
        return null;
      }
      built.file(
        `standardValueSets/${target.set.set}.standardValueSet`,
        metadataFile('StandardValueSet', merged.metadata),
        { type: 'StandardValueSet', member: target.set.set }
      );
      built.components.push({
        type: 'StandardValueSet',
        name: target.set.set,
        action: 'update',
        rows: merged.rows,
      });
      built.preconditions.push({
        kind: 'component-unchanged',
        type: 'StandardValueSet',
        object: target.object,
        name: target.field,
        fingerprint: target.set.fingerprint,
      });
      target.set = {
        ...target.set,
        values: recs(merged.metadata.standardValue).map((v) => ({
          value: str(v.fullName),
          label: str(v.label),
          default: v.default === true,
        })),
      };
      return merged.rows;
    }
  }
}

/** What each record type (or its process) offers of this picklist, in lines. */
async function availabilityLines(
  context: MCPToolContext,
  access: SalesforceAccess,
  object: string,
  field: string
): Promise<string[]> {
  const types = await listRecordTypes(context, access, object);
  if (typeof types === 'string') return [`Record types could not be read: ${types}`];
  if (types.length === 0) return [`${object} has no record types: every value is offered.`];
  const process = processOf(object, field);
  const lines = [process ? `By record type (through each one’s ${process}):` : 'By record type:'];
  const seen = new Map<string, string>();
  for (const rt of types.slice(0, 20)) {
    const head = `• ${rt.label} (${rt.developerName})${rt.active ? '' : ', inactive'}`;
    if (process) {
      if (!rt.businessProcessId) {
        lines.push(`${head}: no ${process}`);
        continue;
      }
      const cached = seen.get(rt.businessProcessId);
      if (cached) {
        lines.push(`${head}: ${cached}`);
        continue;
      }
      const live = await readBusinessProcess(context, access, rt.businessProcessId);
      const offered =
        live && typeof live !== 'string'
          ? `${live.name}: ${recs(live.metadata.values)
              .map((v) => (v.default === true ? `${str(v.fullName)} (default)` : str(v.fullName)))
              .join(', ')}`
          : 'could not be read';
      seen.set(rt.businessProcessId, offered);
      lines.push(`${head}: ${offered}`);
      continue;
    }
    const live = await readRecordType(context, access, rt.id);
    if (!live || typeof live === 'string') {
      lines.push(`${head}: could not be read`);
      continue;
    }
    const entry = recordTypePicklists(live.metadata).find(
      (p) => p.picklist.toLowerCase() === field.toLowerCase()
    );
    lines.push(
      `${head}: ${entry ? entry.values.join(', ') : 'does not list it (Salesforce’s default)'}`
    );
  }
  if (types.length > 20) lines.push(`…and ${types.length - 20} more.`);
  return lines;
}

/** A value as a record type or process names it, decoded. */
function plainName(value: unknown): string {
  const name = str(value);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

interface NamedChange {
  add: string[];
  remove: string[];
  defaultValue?: string;
}

/**
 * The record type (or business process) changes, each read whole first:
 * added values offered wherever the picklist is listed, deactivated
 * values taken off wherever they are offered, and each named record
 * type's own change. Summary lines back; errors pushed.
 */
async function planAvailability(
  context: MCPToolContext,
  access: SalesforceAccess,
  input: {
    object: string;
    field: string;
    /** The picklist's active values after the change: what may be offered. */
    known: string[];
    addEverywhere: string[];
    removeEverywhere: string[];
    perType: { recordType: string; add?: string[]; remove?: string[]; default?: string }[];
    built: PackageBuilder;
    errors: string[];
  }
): Promise<string[]> {
  const { object, field, built, errors } = input;
  if (input.addEverywhere.length + input.removeEverywhere.length + input.perType.length === 0)
    return [];
  const types = await listRecordTypes(context, access, object);
  if (typeof types === 'string') {
    errors.push(`Could not read the record types: ${types}`);
    return [];
  }
  if (types.length === 0) {
    if (input.perType.length > 0) errors.push(`${object} has no record types.`);
    return [];
  }

  const named = new Map<string, NamedChange>();
  for (const entry of input.perType) {
    const rt = findRecordType(types, entry.recordType);
    if (typeof rt === 'string') {
      errors.push(rt);
      continue;
    }
    const current = named.get(rt.id) ?? { add: [], remove: [] };
    named.set(rt.id, {
      add: [...current.add, ...(entry.add ?? [])],
      remove: [...current.remove, ...(entry.remove ?? [])],
      ...(entry.default !== undefined
        ? { defaultValue: entry.default }
        : current.defaultValue !== undefined
          ? { defaultValue: current.defaultValue }
          : {}),
    });
  }

  // Where the change lands: each record type, or each business process for the fields one controls.
  const process = processOf(object, field);
  const targets: {
    type: 'RecordType' | 'BusinessProcess';
    id: string;
    types: RecordTypeRef[];
    named: NamedChange | null;
  }[] = [];
  if (process) {
    for (const rt of types) {
      if (!rt.businessProcessId) {
        if (named.has(rt.id)) errors.push(`The record type ${rt.label} has no ${process}.`);
        continue;
      }
      const target = targets.find((t) => t.id === rt.businessProcessId);
      const own = named.get(rt.id) ?? null;
      if (!target) {
        targets.push({
          type: 'BusinessProcess',
          id: rt.businessProcessId,
          types: [rt],
          named: own,
        });
        continue;
      }
      target.types.push(rt);
      if (own) {
        target.named = {
          add: [...(target.named?.add ?? []), ...own.add],
          remove: [...(target.named?.remove ?? []), ...own.remove],
          ...(own.defaultValue !== undefined
            ? { defaultValue: own.defaultValue }
            : target.named?.defaultValue !== undefined
              ? { defaultValue: target.named.defaultValue }
              : {}),
        };
      }
    }
  } else {
    for (const rt of types) {
      targets.push({ type: 'RecordType', id: rt.id, types: [rt], named: named.get(rt.id) ?? null });
    }
  }

  const lines: string[] = [];
  for (const target of targets) {
    const names = target.types.map((rt) => rt.label).join(', ');
    const live =
      target.type === 'RecordType'
        ? await readRecordType(context, access, target.id)
        : await readBusinessProcess(context, access, target.id);
    if (!live || typeof live === 'string') {
      errors.push(
        `Could not read ${target.type === 'RecordType' ? 'the record type' : `the ${process} of`} ${names}.`
      );
      continue;
    }
    const offered =
      target.type === 'RecordType'
        ? recs(
            recs(live.metadata.picklistValues).find(
              (p) => str(p.picklist).toLowerCase() === field.toLowerCase()
            )?.values
          )
        : recs(live.metadata.values);
    const listed =
      target.type === 'BusinessProcess' ||
      recs(live.metadata.picklistValues).some(
        (p) => str(p.picklist).toLowerCase() === field.toLowerCase()
      );
    if (!listed && !target.named) continue; // Salesforce's default there: nothing to add to.
    const offeredNames = offered.map((v) => plainName(v.fullName).toLowerCase());
    const change: AvailabilityChange = {
      add: [...new Set([...input.addEverywhere, ...(target.named?.add ?? [])])].filter(
        (v) => !offeredNames.includes(v.toLowerCase())
      ),
      remove: [
        ...new Set([
          ...input.removeEverywhere.filter((v) => offeredNames.includes(v.toLowerCase())),
          ...(target.named?.remove ?? []),
        ]),
      ],
      ...(target.named?.defaultValue !== undefined
        ? { defaultValue: target.named.defaultValue }
        : {}),
    };
    if (!target.named && (change.add ?? []).length === 0 && (change.remove ?? []).length === 0)
      continue;
    const merged =
      target.type === 'RecordType'
        ? mergeRecordTypePicklist(live.metadata, field, change, input.known)
        : mergeBusinessProcessValues(live.metadata, live.name, change, input.known);
    if (!merged.ok) {
      errors.push(...merged.errors);
      continue;
    }
    const element = target.type === 'RecordType' ? 'recordTypes' : 'businessProcesses';
    built.objectChild(object, objectChildXml(element, live.name, merged.metadata), {
      type: target.type,
      member: `${object}.${live.name}`,
    });
    built.components.push({
      type: target.type,
      name: `${object}.${live.name}`,
      action: 'update',
      rows: merged.rows,
    });
    built.preconditions.push({
      kind: 'component-unchanged',
      type: target.type,
      object,
      name: live.name,
      fingerprint: live.fingerprint,
    });
    lines.push(
      target.type === 'BusinessProcess'
        ? `On the ${process} ${live.name} (${names}):`
        : `On the record type ${names}:`
    );
    lines.push(...merged.rows.map(rowLine));
  }
  return lines;
}
