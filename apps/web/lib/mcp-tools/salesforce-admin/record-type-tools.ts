/**
 * Record types: reading an object's (with each one's business process,
 * what it offers of each picklist, and the layout each profile sees), and
 * proposing a new one or a change to one — its label, whether it is
 * active, its process, which values of each picklist it offers — with the
 * profiles that may use it and the layout they get. A record type deploys
 * as a child of its object, an existing one read whole and written back
 * with only the change (guarded by a hash of what was read); profile access
 * deploys as a Profile file holding only that, which Salesforce overlays
 * on the profile. Record type access in an existing permission set is not
 * offered: a permission set deploys whole (a new one can carry it —
 * salesforce_admin_propose_permission_set).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  checkRecordTypeSpec,
  metadataFileName,
  objectChildXml,
  PROCESS_OBJECTS,
  processOf,
  profileOverlayFile,
  recordTypeMetadata,
  recordTypePicklists,
  soqlString,
  STANDARD_VALUE_SETS,
  availableValueName,
  type ProfileRecordTypeAccess,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, rec, recs, str, textResult } from '../salesforce/client';
import { resolveObject } from '../salesforce/schema';
import { objectField } from '../salesforce/fields';
import {
  listLayouts,
  RECORD_TYPE_KIND,
  toolingQuery,
  type ViewRow,
} from '@/lib/salesforce-admin/plan';
import {
  findRecordType,
  listBusinessProcesses,
  listRecordTypes,
  readBusinessProcess,
  readProfile,
  readRecordType,
} from '@/lib/salesforce-admin/whole-components';
import { PackageBuilder } from './package-builder';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const PICKLIST_TYPES = new Set(['picklist', 'multipicklist']);

const picklistsField = z
  .array(
    z.object({
      field: z.string().min(1).describe('The picklist field’s API name.'),
      values: z.array(z.string().min(1)).min(1).describe('The values this record type offers.'),
      default: z.string().optional().describe('Its default, one of those.'),
    })
  )
  .max(50)
  .optional();

const profilesField = z
  .array(
    z.object({
      profile: z.string().min(1).describe('The profile’s name ("Standard User").'),
      layout: z.string().optional().describe('The page layout they see for this record type.'),
      default: z
        .boolean()
        .optional()
        .describe('Make it the profile’s default record type on this object.'),
    })
  )
  .max(30)
  .optional()
  .describe('Profiles that may use the record type, and the layout each sees.');

export function registerAdminRecordTypeTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_get_record_type',
    {
      title: 'Salesforce Admin · Read — Record types',
      description:
        'An object’s record types — active or not, their business process (Opportunity, Lead, ' +
        'Case), description; with `recordType`, what that one offers of each picklist and the ' +
        'layout each profile sees for it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        object: objectField,
        recordType: z.string().optional().describe('A record type’s API name or label.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const types = await listRecordTypes(context, access, describe.name);
      if (typeof types === 'string') return errText(types);
      const processes = PROCESS_OBJECTS[describe.name]
        ? await listBusinessProcesses(context, access, describe.name)
        : [];
      const processName = (id: string) =>
        Array.isArray(processes) ? processes.find((p) => p.id === id)?.name : undefined;

      if (!args.recordType) {
        if (types.length === 0)
          return textResult(`${describe.name} has no record types: everyone uses the master.`);
        return textResult(
          [
            `${describe.label} (${describe.name}) record types:`,
            ...types.map(
              (rt) =>
                `• ${rt.label} (${rt.developerName})${rt.active ? '' : ', inactive'}${
                  rt.businessProcessId
                    ? ` — ${processName(rt.businessProcessId) ?? 'a process'}`
                    : ''
                }${rt.description ? `\n  ${rt.description}` : ''}`
            ),
            ...(Array.isArray(processes) && processes.length
              ? [
                  '',
                  `Its ${PROCESS_OBJECTS[describe.name]}es: ${processes.map((p) => p.name).join(', ')}.`,
                ]
              : []),
          ].join('\n')
        );
      }

      const rt = findRecordType(types, args.recordType);
      if (typeof rt === 'string') return errText(rt);
      const live = await readRecordType(context, access, rt.id);
      if (typeof live === 'string') return errText(live);
      if (!live) return errText(`The record type ${rt.label} is gone.`);
      const assigned = await toolingQuery(
        context,
        access,
        `SELECT Profile.Name, Layout.Name FROM ProfileLayout WHERE RecordTypeId = ${soqlString(rt.id)}`
      );
      const lines = [
        `Record type ${rt.label} (${describe.name}.${rt.developerName})${rt.active ? '' : ' — inactive'}`,
        ...(rt.description ? [rt.description] : []),
        ...(rt.businessProcessId
          ? [
              `${PROCESS_OBJECTS[describe.name]}: ${processName(rt.businessProcessId) ?? rt.businessProcessId}`,
            ]
          : []),
        '',
        'Picklists it offers:',
        ...recordTypePicklists(live.metadata).map((p) => `• ${p.picklist}: ${p.values.join(', ')}`),
      ];
      if (rt.businessProcessId) {
        const process = await readBusinessProcess(context, access, rt.businessProcessId);
        if (process && typeof process !== 'string') {
          lines.push(
            `• (from the process) ${recs(process.metadata.values)
              .map((v) => (v.default === true ? `${str(v.fullName)} (default)` : str(v.fullName)))
              .join(', ')}`
          );
        }
      }
      lines.push(
        '',
        'Layout by profile:',
        ...(assigned.ok
          ? assigned.records.length
            ? assigned.records.map(
                (r) => `• ${str(rec(r.Profile).Name)}: ${str(rec(r.Layout).Name)}`
              )
            : ['• none assigned']
          : [`• could not be read: ${assigned.error}`])
      );
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'salesforce_admin_propose_record_type',
    {
      title: 'Salesforce Admin · Act — Propose a record type, or a change to one',
      description:
        'Propose a new record type on an object, or a change to an existing one (recordType): ' +
        'label, description, active, its business process (required on Opportunity, Lead and ' +
        'Case), which values of each picklist it offers (a new one offers every value of the ' +
        'picklists not named), and the profiles that may use it with the layout each sees. ' +
        'Checked by a validation deploy that changes nothing; the person reviews and applies it ' +
        'from the link this returns. Read first: salesforce_admin_get_record_type.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        object: objectField,
        recordType: z
          .string()
          .optional()
          .describe('An existing record type’s API name or label, to change it.'),
        label: z.string().max(80).optional().describe('Required for a new one.'),
        apiName: z.string().optional().describe('A new one’s API name; default from the label.'),
        description: z.string().max(255).optional(),
        active: z.boolean().optional().describe('Default true for a new one.'),
        businessProcess: z
          .string()
          .optional()
          .describe('Opportunity, Lead, Case: the sales, lead or support process’s name.'),
        picklists: picklistsField,
        profiles: profilesField,
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const describe = await resolveObject(context, access, args.object);
      if (typeof describe === 'string') return errText(describe);
      const object = describe.name;
      const types = await listRecordTypes(context, access, object);
      if (typeof types === 'string') return errText(types);

      // Every picklist a record type can narrow, with its active values.
      const picklists = describe.fields.filter(
        (f) => PICKLIST_TYPES.has(f.type) && !processOf(object, f.name)
      );
      const known = Object.fromEntries(
        picklists.map((f) => [
          f.name,
          (f.picklistValues ?? []).filter((v) => v.active).map((v) => v.value),
        ])
      );
      const errors: string[] = [];
      for (const entry of args.picklists ?? []) {
        const process = processOf(object, entry.field);
        if (process)
          errors.push(
            `${object}.${entry.field} is offered through the ${process}, not the record type.`
          );
      }

      let processName: string | undefined;
      if (args.businessProcess) {
        const processes = await listBusinessProcesses(context, access, object);
        if (typeof processes === 'string') return errText(processes);
        const match = processes.find(
          (p) => p.name.toLowerCase() === args.businessProcess?.trim().toLowerCase()
        );
        if (!match)
          errors.push(
            processes.length
              ? `No process "${args.businessProcess}": ${object}’s are ${processes.map((p) => p.name).join(', ')}.`
              : `${object} has no business processes.`
          );
        else processName = match.name;
      }
      if (errors.length > 0)
        return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);

      const built = new PackageBuilder();
      const summary: string[] = [];
      let developerName: string;
      let label: string;

      if (args.recordType) {
        const rt = findRecordType(types, args.recordType);
        if (typeof rt === 'string') return errText(rt);
        const live = await readRecordType(context, access, rt.id);
        if (typeof live === 'string') return errText(live);
        if (!live) return errText(`The record type ${rt.label} is gone.`);
        const metadata = structuredClone(live.metadata);
        const rows: ViewRow[] = [];
        const shown = (value: unknown) =>
          value === null || value === undefined || value === ''
            ? '(none)'
            : typeof value === 'boolean'
              ? value
                ? 'yes'
                : 'no'
              : String(value);
        const set = (key: string, rowLabel: string, value: unknown) => {
          if (value === undefined || shown(metadata[key]) === shown(value)) return;
          rows.push({ label: rowLabel, value: shown(value), from: shown(metadata[key]) });
          metadata[key] = value;
        };
        set('label', 'Label', args.label?.trim());
        set(
          'description',
          'Description',
          args.description === undefined ? undefined : args.description.trim() || null
        );
        set('active', 'Active', args.active);
        set('businessProcess', 'Process', processName);
        const offered = recs(metadata.picklistValues);
        metadata.picklistValues = offered;
        for (const entry of args.picklists ?? []) {
          const field = Object.keys(known).find(
            (k) => k.toLowerCase() === entry.field.toLowerCase()
          );
          if (!field) {
            errors.push(`${object} has no picklist ${entry.field}.`);
            continue;
          }
          const values: string[] = [];
          for (const value of entry.values) {
            const spelled = known[field].find(
              (k) => k.toLowerCase() === value.trim().toLowerCase()
            );
            if (!spelled) errors.push(`${field}: "${value}" is not one of its active values.`);
            else if (!values.includes(spelled)) values.push(spelled);
          }
          const defaultValue = entry.default
            ? values.find((v) => v.toLowerCase() === entry.default?.trim().toLowerCase())
            : undefined;
          if (entry.default && !defaultValue)
            errors.push(`${field}: the default "${entry.default}" is not offered.`);
          const before = recordTypePicklists({ picklistValues: offered }).find(
            (p) => p.picklist.toLowerCase() === field.toLowerCase()
          );
          const next = {
            picklist: field,
            values: values.map((v) => ({
              fullName: availableValueName(v),
              default: v === defaultValue,
            })),
          };
          const index = offered.findIndex(
            (p) => str(p.picklist).toLowerCase() === field.toLowerCase()
          );
          if (index >= 0) offered[index] = next;
          else offered.push(next);
          const after = recordTypePicklists({ picklistValues: [next] })[0].values.join(', ');
          const from = before?.values.join(', ') ?? 'Salesforce’s default';
          if (after !== from) rows.push({ label: field, value: after, from });
        }
        if (errors.length > 0)
          return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);
        developerName = live.name;
        label = str(metadata.label) || rt.label;
        if (rows.length > 0) {
          built.objectChild(object, objectChildXml('recordTypes', live.name, metadata), {
            type: 'RecordType',
            member: `${object}.${live.name}`,
          });
          built.components.push({
            type: 'RecordType',
            name: `${object}.${live.name}`,
            action: 'update',
            rows,
          });
          built.preconditions.push({
            kind: 'component-unchanged',
            type: 'RecordType',
            object,
            name: live.name,
            fingerprint: live.fingerprint,
          });
          summary.push(
            `• Record type ${object}.${live.name}:`,
            ...rows.map((r) => `  ${r.label}: ${r.from} → ${r.value}`)
          );
        }
      } else {
        // A new one offers every active value of the picklists not named.
        const named = new Set((args.picklists ?? []).map((p) => p.field.toLowerCase()));
        const unnamed = picklists
          .filter((f) => !named.has(f.name.toLowerCase()))
          .filter((f) => f.custom || STANDARD_VALUE_SETS[`${object}.${f.name}`])
          .filter((f) => known[f.name].length > 0)
          .map((f) => ({
            picklist: f.name,
            values: known[f.name],
            default: (f.picklistValues ?? []).find((v) => v.active && v.defaultValue)?.value,
          }));
        const checked = checkRecordTypeSpec(
          {
            object,
            label: args.label,
            name: args.apiName,
            description: args.description,
            active: args.active,
            businessProcess: processName,
            picklists: [
              ...(args.picklists ?? []).map((p) => ({
                picklist: p.field,
                values: p.values,
                default: p.default,
              })),
              ...unnamed,
            ],
          },
          types.map((rt) => ({ name: rt.developerName, label: rt.label })),
          known
        );
        if (!checked.ok)
          return errText(
            `Nothing was proposed:\n${checked.errors.map((e) => `• ${e}`).join('\n')}`
          );
        const spec = checked.value;
        developerName = spec.name;
        label = spec.label;
        built.objectChild(
          object,
          objectChildXml('recordTypes', spec.name, recordTypeMetadata(spec)),
          {
            type: 'RecordType',
            member: `${object}.${spec.name}`,
          }
        );
        built.components.push({
          type: 'RecordType',
          name: `${object}.${spec.name}`,
          action: 'create',
          rows: [
            { label: 'Label', value: spec.label },
            { label: 'Active', value: spec.active ? 'yes' : 'no' },
            ...(spec.businessProcess ? [{ label: 'Process', value: spec.businessProcess }] : []),
            ...(spec.description ? [{ label: 'Description', value: spec.description }] : []),
            ...spec.picklists.map((p) => ({
              label: p.picklist,
              value: p.values.map((v) => (v === p.default ? `${v} (default)` : v)).join(', '),
            })),
          ],
        });
        built.preconditions.push({ kind: 'record-type-absent', object, name: spec.name });
        summary.push(
          `• New record type ${object}.${spec.name} — “${spec.label}”${spec.active ? '' : ' (inactive)'}${spec.businessProcess ? `, ${spec.businessProcess}` : ''}`,
          ...spec.picklists.map((p) => `  ${p.picklist}: ${p.values.join(', ')}`)
        );
      }

      // Profiles: visible, maybe the default, and a layout — an overlay of only that.
      const layouts = (args.profiles ?? []).some((p) => p.layout)
        ? await listLayouts(context, access, object)
        : [];
      if (typeof layouts === 'string') return errText(layouts);
      for (const entry of args.profiles ?? []) {
        const profile = await readProfile(context, access, entry.profile);
        if (typeof profile === 'string') {
          errors.push(profile);
          continue;
        }
        let layout: string | undefined;
        if (entry.layout) {
          const match = layouts.find(
            (l) => l.name.toLowerCase() === entry.layout?.trim().toLowerCase()
          );
          if (!match) {
            errors.push(
              `No layout "${entry.layout}" on ${object}: its layouts are ${layouts.map((l) => `“${l.name}”`).join(', ')}.`
            );
            continue;
          }
          layout = `${object}-${match.name}`;
        }
        const grant: ProfileRecordTypeAccess = {
          recordType: `${object}.${developerName}`,
          default: entry.default === true,
          ...(layout ? { layout } : {}),
        };
        built.file(
          `profiles/${metadataFileName(profile.fullName)}.profile`,
          profileOverlayFile([grant]),
          { type: 'Profile', member: profile.fullName }
        );
        built.components.push({
          type: 'Profile',
          name: profile.name,
          action: 'update',
          rows: [
            {
              label: 'May use',
              value: `${label} (${object}.${developerName})${grant.default ? ', by default' : ''}`,
            },
            ...(layout ? [{ label: 'Layout for it', value: layout.slice(object.length + 1) }] : []),
          ],
        });
        summary.push(
          `• ${profile.name} may use it${grant.default ? ' (the default)' : ''}${layout ? `, with the layout “${layout.slice(object.length + 1)}”` : ''}`
        );
      }
      if (errors.length > 0)
        return errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);
      if (!built.deploys)
        return errText('Nothing was proposed: nothing in that changes the record type.');
      if (!args.recordType && (args.profiles ?? []).length === 0) {
        summary.push(
          'No profile is given it: people with a new permission set that names it can use it (salesforce_admin_propose_permission_set), or name profiles.'
        );
      }
      return proposeAndValidate(context, access, {
        kind: RECORD_TYPE_KIND,
        title: `${describe.label}: ${args.recordType ? 'change' : 'add'} the record type ${label}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: built.build(),
        summary,
      });
    }
  );
}
