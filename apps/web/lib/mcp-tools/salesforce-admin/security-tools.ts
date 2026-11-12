/**
 * What decides who can administer the org and who can sign in, behind its
 * own capability (security, off by default): system permissions in a
 * permission set or profile, a profile's login hours and login IP ranges,
 * and new profiles.
 *
 * A system permission is a `Permissions…` checkbox on the set's or the
 * profile's own row, written one at a time, so nothing else in it moves.
 * Login hours and IP ranges deploy as a Profile file holding only them —
 * Salesforce overlays a profile, but replaces these two whole, so the
 * proposal reads what the profile has (readMetadata), changes it, and
 * sends the whole list; applying is refused if the profile moved since. A
 * new profile deploys as a Profile file: from a user licence alone, or as
 * a copy of an existing profile as readMetadata hands it over.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  metadataFile,
  metadataFileName,
  packageXml,
  soqlString,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { errText, rec, sfQuery, str, type SalesforceAccess } from '../salesforce/client';
import { describeObject } from '../salesforce/schema';
import {
  resolvePermissionSet,
  resolveProfileAccess,
  SECURITY_KIND,
  type DataStep,
  type ViewRow,
} from '@/lib/salesforce-admin/plan';
import { readProfile, readWholeMetadata } from '@/lib/salesforce-admin/whole-components';
import { proposeAndValidate, reasonField, refusesChanges, replacesField } from './shared';

const bullets = (errors: string[]) =>
  errText(`Nothing was proposed:\n${errors.map((e) => `• ${e}`).join('\n')}`);

const many = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(rec);

export interface SystemPermission {
  /** The field: PermissionsViewSetup. */
  field: string;
  /** What Setup calls it: View Setup and Configuration. */
  label: string;
}

/** The org's system permissions: the Permissions… checkboxes a permission set carries. */
export async function systemPermissions(
  context: MCPToolContext,
  access: SalesforceAccess
): Promise<SystemPermission[] | string> {
  const describe = await describeObject(context, access, 'PermissionSet');
  if (typeof describe === 'string') return describe;
  return describe.fields
    .filter((field) => field.type === 'boolean' && /^Permissions[A-Za-z0-9]+$/.test(field.name))
    .map((field) => ({ field: field.name, label: field.label }));
}

/** A system permission by its API name (with or without `Permissions`) or its Setup label. */
export function findSystemPermission(
  all: readonly SystemPermission[],
  ref: string
): SystemPermission | undefined {
  const wanted = ref.trim().toLowerCase();
  return all.find(
    (permission) =>
      permission.field.toLowerCase() === wanted ||
      permission.field.toLowerCase() === `permissions${wanted}` ||
      permission.label.toLowerCase() === wanted
  );
}

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
type Day = (typeof DAYS)[number];

/** "08:30" as minutes from midnight; "24:00" is the end of the day. */
export function minutesOf(time: string): number | null {
  const match = /^([01]?\d|2[0-4]):([0-5]\d)$/.exec(time.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 1440 ? minutes : null;
}

const timeOf = (minutes: unknown): string => {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return '?';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

/** A profile's login hours as read, in words: "Mon 08:00–18:00, …", or none. */
export function loginHoursWords(hours: unknown): string {
  const entry = rec(hours);
  const days = DAYS.filter((day) => entry[`${day}Start`] !== undefined);
  if (days.length === 0) return 'any time';
  return days
    .map(
      (day) =>
        `${day.slice(0, 1).toUpperCase()}${day.slice(1, 3)} ${timeOf(entry[`${day}Start`])}–${timeOf(entry[`${day}End`])}`
    )
    .join(', ');
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,39}$/;
const isAddress = (value: string) => IPV4.test(value) || (value.includes(':') && IPV6.test(value));
const ipv4Number = (value: string) =>
  value.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);

const rangeWords = (range: Record<string, unknown>) =>
  `${str(range.startAddress)}–${str(range.endAddress)}${str(range.description) ? ` (${str(range.description)})` : ''}`;

export function registerAdminSecurityTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  server.registerTool(
    'salesforce_admin_propose_system_permissions',
    {
      title: 'Salesforce Admin · Act — Propose system permissions',
      description:
        'Propose turning system permissions on or off in an existing permission set or a ' +
        'profile — View Setup and Configuration, Manage Users, Modify All Data, API Enabled… — ' +
        'by their Setup name or API name. These decide who can administer the org: say in the ' +
        'reason who asked for it and why. Salesforce turns on what a permission needs and ' +
        'refuses to turn off one another still needs; either shows as that step’s result. The ' +
        'person reviews and applies it from the link this returns.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        permissionSet: z.string().optional().describe('An existing set’s API name or label.'),
        profile: z.string().optional().describe('In place of permissionSet: a profile’s name.'),
        enable: z
          .array(z.string().min(1))
          .max(30)
          .optional()
          .describe('System permissions to turn on: "Manage Users", or ManageUsers.'),
        disable: z.array(z.string().min(1)).max(30).optional().describe('…and to turn off.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      if (Boolean(args.permissionSet) === Boolean(args.profile)) {
        return errText('Name either permissionSet (an existing set) or profile.');
      }
      const asked = [...(args.enable ?? []), ...(args.disable ?? [])];
      if (asked.length === 0) return errText('Name system permissions to enable or disable.');
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const profile = args.profile
        ? await resolveProfileAccess(context, access, args.profile)
        : null;
      if (typeof profile === 'string') return errText(profile);
      const set =
        profile ?? (await resolvePermissionSet(context, access, args.permissionSet ?? ''));
      if (typeof set === 'string') return errText(set);

      const all = await systemPermissions(context, access);
      if (typeof all === 'string') return errText(all);
      const errors: string[] = [];
      const wanted = new Map<string, { permission: SystemPermission; enabled: boolean }>();
      for (const [refs, enabled] of [
        [args.enable ?? [], true],
        [args.disable ?? [], false],
      ] as const) {
        for (const ref of refs) {
          const permission = findSystemPermission(all, ref);
          if (!permission) {
            const close = all
              .filter((p) => p.label.toLowerCase().includes(ref.trim().toLowerCase()))
              .slice(0, 6)
              .map((p) => `${p.label} (${p.field.replace(/^Permissions/, '')})`);
            errors.push(
              `There is no system permission "${ref}"${close.length ? ` — did you mean ${close.join(', ')}?` : '.'}`
            );
          } else if (wanted.has(permission.field)) {
            errors.push(`“${permission.label}” is named more than once.`);
          } else wanted.set(permission.field, { permission, enabled });
        }
      }
      if (errors.length > 0) return bullets(errors);

      const now = await sfQuery(
        context,
        access,
        `SELECT ${[...wanted.keys()].join(', ')} FROM PermissionSet WHERE Id = ${soqlString(set.id)} LIMIT 1`
      );
      if (!now.ok) return errText(now.error);
      const current = now.records[0] ?? {};
      const steps: DataStep[] = [];
      const rows: ViewRow[] = [];
      const unchanged: string[] = [];
      for (const { permission, enabled } of wanted.values()) {
        if ((current[permission.field] === true) === enabled) {
          unchanged.push(
            `${set.name} already has “${permission.label}” ${enabled ? 'on' : 'off'}.`
          );
          continue;
        }
        steps.push({
          kind: 'system-permission',
          permissionSetId: set.id,
          permissionSetName: set.name,
          target: profile ? 'Profile' : 'PermissionSet',
          targetId: profile ? profile.profileId : set.id,
          permission: permission.field,
          label: permission.label,
          enabled,
        });
        rows.push({
          label: permission.label,
          value: enabled ? 'on' : 'off',
          from: enabled ? 'off' : 'on',
        });
      }
      if (steps.length === 0) {
        return errText(`Nothing was proposed: nothing would change.\n${unchanged.join('\n')}`);
      }
      const holder = profile ? `The profile ${profile.profile}` : set.name;
      return proposeAndValidate(context, access, {
        kind: SECURITY_KIND,
        title: `${holder}: system permissions`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: {},
          members: [],
          components: [
            {
              type: profile ? 'Profile' : 'PermissionSet',
              name: profile ? profile.profile : set.name,
              action: 'update',
              rows,
            },
          ],
          preconditions: [],
          dataSteps: steps,
        },
        summary: [
          `• ${holder} — system permissions, for everyone who has it:`,
          ...rows.map((row) => `  ${row.label}: ${row.from} → ${row.value}`),
          ...unchanged,
        ],
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_profile_login',
    {
      title: 'Salesforce Admin · Act — Propose a profile’s login hours and IP ranges',
      description:
        'Propose when and from where people on a profile can sign in: login IP ranges to add ' +
        'or remove, and login hours — all seven days given together, each with a start and an ' +
        'end, or clearLoginHours to lift them. A mistake here locks people out: read what the ' +
        'profile has first (salesforce_admin_list_permission_sets, profile and security: ' +
        'true). Salesforce refuses ranges that would shut out the person applying it. The ' +
        'person reviews and applies it from the link this returns.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        profile: z.string().min(1).describe('The profile’s name ("Standard User").'),
        addIpRanges: z
          .array(
            z.object({
              start: z.string().min(1).describe('The first address: 203.0.113.0'),
              end: z.string().min(1).describe('The last address: 203.0.113.255'),
              description: z.string().max(255).optional(),
            })
          )
          .max(20)
          .optional(),
        removeIpRanges: z
          .array(z.object({ start: z.string().min(1), end: z.string().min(1) }))
          .max(20)
          .optional()
          .describe('Ranges the profile has, by their first and last address.'),
        loginHours: z
          .array(
            z.object({
              day: z.enum(DAYS),
              start: z.string().describe('24-hour HH:MM in the org’s time zone: 08:00'),
              end: z.string().describe('HH:MM; 24:00 is the end of the day'),
            })
          )
          .optional()
          .describe(
            'All seven days, once each. A day people may sign in at any time is 00:00 to 24:00.'
          ),
        clearLoginHours: z.boolean().optional().describe('Lift the login hours: any time.'),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      const adding = args.addIpRanges ?? [];
      const removing = args.removeIpRanges ?? [];
      if (args.loginHours && args.clearLoginHours) {
        return errText('Give loginHours or clearLoginHours, not both.');
      }
      if (adding.length + removing.length === 0 && !args.loginHours && !args.clearLoginHours) {
        return errText('Name IP ranges to add or remove, login hours, or clearLoginHours.');
      }
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const profile = await readProfile(context, access, args.profile);
      if (typeof profile === 'string') return errText(profile);
      const live = await readWholeMetadata(context, access, 'Profile', profile.fullName);
      if (typeof live === 'string') return errText(`Nothing was proposed: ${live}`);
      if (!live) return errText(`Nothing was proposed: ${profile.name} could not be read whole.`);

      const errors: string[] = [];
      const rows: ViewRow[] = [];
      const overlay: Record<string, unknown> = {};

      if (adding.length + removing.length > 0) {
        let ranges = many(live.metadata.loginIpRanges);
        const before = ranges.map(rangeWords).join('; ') || 'any address';
        const same = (range: Record<string, unknown>, start: string, end: string) =>
          str(range.startAddress).toLowerCase() === start.trim().toLowerCase() &&
          str(range.endAddress).toLowerCase() === end.trim().toLowerCase();
        for (const range of removing) {
          if (!ranges.some((r) => same(r, range.start, range.end))) {
            errors.push(
              `${profile.name} has no login range ${range.start}–${range.end}. It has: ${before}.`
            );
            continue;
          }
          ranges = ranges.filter((r) => !same(r, range.start, range.end));
        }
        for (const range of adding) {
          const [start, end] = [range.start.trim(), range.end.trim()];
          if (!isAddress(start) || !isAddress(end)) {
            errors.push(`${start}–${end} is not a range of IP addresses.`);
          } else if (IPV4.test(start) !== IPV4.test(end)) {
            errors.push(`${start}–${end} mixes an IPv4 and an IPv6 address.`);
          } else if (IPV4.test(start) && ipv4Number(start) > ipv4Number(end)) {
            errors.push(`${start}–${end} ends before it starts.`);
          } else if (ranges.some((r) => same(r, start, end))) {
            errors.push(`${profile.name} already has the login range ${start}–${end}.`);
          } else {
            ranges = [
              ...ranges,
              {
                ...(range.description?.trim() ? { description: range.description.trim() } : {}),
                endAddress: end,
                startAddress: start,
              },
            ];
          }
        }
        if (errors.length === 0 && ranges.length === 0) {
          // An absent list leaves the ranges as they are, so the last one
          // cannot be taken away by a deploy that names none.
          errors.push(
            `That would leave ${profile.name} with no login ranges, which a deploy cannot say: remove the last range in Setup (the profile’s Login IP Ranges).`
          );
        }
        overlay.loginIpRanges = ranges;
        rows.push({
          label: 'Login IP ranges',
          value: ranges.map(rangeWords).join('; '),
          from: before,
        });
      }

      if (args.loginHours) {
        const byDay = new Map<Day, { start: number; end: number }>();
        for (const entry of args.loginHours) {
          const [start, end] = [minutesOf(entry.start), minutesOf(entry.end)];
          if (start === null || end === null) {
            errors.push(`${entry.day}: ${entry.start}–${entry.end} is not HH:MM to HH:MM.`);
          } else if (end <= start) {
            errors.push(`${entry.day}: the hours end (${entry.end}) at or before they start.`);
          } else if (byDay.has(entry.day)) {
            errors.push(`${entry.day} is given more than once.`);
          } else byDay.set(entry.day, { start, end });
        }
        const missing = DAYS.filter((day) => !byDay.has(day));
        if (errors.length === 0 && missing.length > 0) {
          errors.push(
            `Give every day, so none is left to guesswork: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing (00:00 to 24:00 is any time that day).`
          );
        }
        const hours: Record<string, string> = {};
        for (const day of DAYS) {
          const entry = byDay.get(day);
          if (!entry) continue;
          hours[`${day}End`] = String(entry.end);
          hours[`${day}Start`] = String(entry.start);
        }
        overlay.loginHours = hours;
        rows.push({
          label: 'Login hours',
          value: loginHoursWords(hours),
          from: loginHoursWords(live.metadata.loginHours),
        });
      }
      if (args.clearLoginHours) {
        const before = loginHoursWords(live.metadata.loginHours);
        if (before === 'any time') errors.push(`${profile.name} has no login hours to lift.`);
        // An empty element is how a deploy says "no login hours".
        overlay.loginHours = {};
        rows.push({ label: 'Login hours', value: 'any time', from: before });
      }
      if (errors.length > 0) return bullets(errors);

      const members = [{ type: 'Profile', member: profile.fullName }];
      return proposeAndValidate(context, access, {
        kind: SECURITY_KIND,
        title: `The profile ${profile.name}: when and from where people sign in`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: {
            'package.xml': packageXml(members),
            [`profiles/${metadataFileName(profile.fullName)}.profile`]: metadataFile(
              'Profile',
              overlay
            ),
          },
          members,
          components: [{ type: 'Profile', name: profile.name, action: 'update', rows }],
          preconditions: [
            {
              kind: 'component-unchanged',
              type: 'Profile',
              object: '',
              name: profile.fullName,
              fingerprint: live.fingerprint,
            },
          ],
          dataSteps: [],
        },
        summary: [
          `• The profile ${profile.name}, for everyone on it:`,
          ...rows.map((row) => `  ${row.label}: ${row.from} → ${row.value}`),
        ],
      });
    }
  );

  server.registerTool(
    'salesforce_admin_propose_profile',
    {
      title: 'Salesforce Admin · Act — Propose a new profile',
      description:
        'Propose a new custom profile: as a copy of an existing profile (copyFrom), with ' +
        'everything it grants, or from a user licence alone (userLicense), with the licence’s ' +
        'defaults. Nobody is on it until a user is moved to it in Setup. The person reviews ' +
        'and applies it from the link this returns.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('The new profile’s name.'),
        copyFrom: z.string().optional().describe('An existing profile to copy.'),
        userLicense: z
          .string()
          .optional()
          .describe('In place of copyFrom: the user licence’s name ("Salesforce").'),
        description: z.string().max(255).optional(),
        reason: reasonField,
        replaces: replacesField,
      }),
    },
    async (args) => {
      if (Boolean(args.copyFrom) === Boolean(args.userLicense)) {
        return errText('Name either copyFrom (a profile to copy) or userLicense.');
      }
      const name = args.name.trim();
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const refused = await refusesChanges(access);
      if (refused) return errText(refused);
      const taken = await sfQuery(
        context,
        access,
        `SELECT Id FROM Profile WHERE Name = ${soqlString(name)} LIMIT 1`
      );
      if (!taken.ok) return errText(taken.error);
      if (taken.records.length > 0) {
        return errText(`Nothing was proposed: there is already a profile ${name}.`);
      }

      let metadata: Record<string, unknown>;
      const rows: ViewRow[] = [];
      if (args.copyFrom) {
        const source = await readProfile(context, access, args.copyFrom);
        if (typeof source === 'string') return errText(source);
        const live = await readWholeMetadata(context, access, 'Profile', source.fullName);
        if (typeof live === 'string') return errText(`Nothing was proposed: ${live}`);
        if (!live) return errText(`Nothing was proposed: ${source.name} could not be read whole.`);
        metadata = { ...live.metadata, custom: true };
        rows.push({ label: 'Copied from', value: source.name });
        const licence = str(live.metadata.userLicense);
        if (licence) rows.push({ label: 'User licence', value: licence });
      } else {
        const licence = await sfQuery(
          context,
          access,
          `SELECT Name FROM UserLicense WHERE Name = ${soqlString((args.userLicense ?? '').trim())} LIMIT 1`
        );
        if (!licence.ok) return errText(licence.error);
        if (licence.records.length === 0) {
          return errText(`Nothing was proposed: there is no user licence "${args.userLicense}".`);
        }
        metadata = { custom: true, userLicense: str(licence.records[0].Name) };
        rows.push({ label: 'User licence', value: str(licence.records[0].Name) });
      }
      const description = args.description?.trim();
      if (description) {
        metadata = { ...metadata, description };
        rows.push({ label: 'Description', value: description });
      }
      const members = [{ type: 'Profile', member: name }];
      return proposeAndValidate(context, access, {
        kind: SECURITY_KIND,
        title: `New profile ${name}`,
        reason: args.reason,
        replaces: args.replaces,
        payload: {
          files: {
            'package.xml': packageXml(members),
            [`profiles/${metadataFileName(name)}.profile`]: metadataFile('Profile', metadata),
          },
          members,
          components: [{ type: 'Profile', name, action: 'create', rows }],
          preconditions: [{ kind: 'profile-absent', name }],
          dataSteps: [],
        },
        summary: [
          `• New profile ${name}${args.copyFrom ? `, a copy of ${rows[0].value}` : `, on the ${rows[0].value} licence`}. Nobody is on it yet.`,
        ],
      });
    }
  );
}
