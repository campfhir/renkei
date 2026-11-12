/**
 * Permission sets Salesforce will not take a row at a time.
 *
 * Access in an existing set is normally data: one FieldPermissions,
 * ObjectPermissions or tab-setting row per step. A set that belongs to a
 * permission set group refuses that ("its parent is associated with a
 * permission set group"), so for one of those the same steps are folded
 * into the set's whole definition — read with readMetadata, changed only
 * where the steps say, deployed whole, and refused on apply if the set
 * moved since it was read. Record types, which have no row at all, go the
 * same way.
 *
 * A whole deploy replaces the set, so it is only as safe as the read: the
 * definition read is checked against the access rows the set has, and a
 * read that holds fewer grants than the org does is not deployed.
 */

import {
  mergePermissionSetAccess,
  metadataFile,
  metadataFileName,
  permissionSetGrantCounts,
  soqlString,
  type PackageMember,
  type PermissionSetAccessChanges,
} from '@renkei/connector-salesforce';
import type { MCPToolContext } from '../common';
import { rec, sfQuery, str, type SalesforceAccess } from '../salesforce/client';
import type { DataStep, Precondition } from '@/lib/salesforce-admin/plan';
import { readWholeMetadata } from '@/lib/salesforce-admin/whole-components';

/** The permission set groups a set belongs to, by label; empty when it is in none. */
export async function groupsOf(
  context: MCPToolContext,
  access: SalesforceAccess,
  permissionSetId: string
): Promise<string[] | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT PermissionSetGroup.MasterLabel, PermissionSetGroup.DeveloperName FROM PermissionSetGroupComponent WHERE PermissionSetId = ${soqlString(permissionSetId)} LIMIT 50`
  );
  if (!found.ok) return found.error;
  return found.records.map((row) => {
    const group = rec(row.PermissionSetGroup);
    return str(group.MasterLabel) || str(group.DeveloperName) || 'a permission set group';
  });
}

/** The steps a whole definition can carry, as changes to it; the rest are returned as they are. */
export function accessChangesOf(steps: readonly DataStep[]): {
  changes: PermissionSetAccessChanges;
  left: DataStep[];
} {
  const changes: Required<Omit<PermissionSetAccessChanges, 'recordTypes'>> = {
    fields: [],
    objects: [],
    tabs: [],
  };
  const left: DataStep[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case 'field-permission':
        changes.fields.push({
          field: `${step.object}.${step.field}`,
          access:
            step.remove === 'all'
              ? null
              : step.remove === 'edit'
                ? { read: true, edit: false }
                : { read: true, edit: step.edit },
        });
        break;
      case 'object-permission':
        changes.objects.push({
          object: step.object,
          rights: step.read
            ? {
                read: true,
                create: step.create,
                edit: step.edit,
                delete: step.delete,
                viewAll: step.viewAll,
                modifyAll: step.modifyAll,
              }
            : null,
        });
        break;
      case 'tab-visibility':
        changes.tabs.push({ tab: step.tab, shown: !step.remove });
        break;
      default:
        left.push(step);
    }
  }
  return { changes, left };
}

export interface WholeSetPart {
  path: string;
  content: string;
  member: PackageMember;
  precondition: Precondition;
}

/**
 * The set's whole definition with the changes merged in, as a deploy
 * carries it — or why it cannot be done this way.
 */
export async function planWholeSetChange(
  context: MCPToolContext,
  access: SalesforceAccess,
  set: { id: string; name: string },
  changes: PermissionSetAccessChanges
): Promise<WholeSetPart | string> {
  const live = await readWholeMetadata(context, access, 'PermissionSet', set.name);
  if (typeof live === 'string') return live;
  if (!live) return `${set.name} could not be read whole.`;

  // The deploy replaces the set, so a read that left anything out would
  // take it away. The access rows are the org's own count of what it grants.
  const parent = soqlString(set.id);
  const [fieldRows, objectRows] = await Promise.all([
    sfQuery(context, access, `SELECT COUNT(Id) n FROM FieldPermissions WHERE ParentId = ${parent}`),
    sfQuery(
      context,
      access,
      `SELECT COUNT(Id) n FROM ObjectPermissions WHERE ParentId = ${parent}`
    ),
  ]);
  if (!fieldRows.ok) return fieldRows.error;
  if (!objectRows.ok) return objectRows.error;
  const read = permissionSetGrantCounts(live.metadata);
  const held = {
    fields: Number(fieldRows.records[0]?.n ?? 0),
    objects: Number(objectRows.records[0]?.n ?? 0),
  };
  if (read.fields < held.fields || read.objects < held.objects) {
    return (
      `${set.name} cannot be changed safely from here: Salesforce handed over ${read.fields} of its ` +
      `${held.fields} field grants and ${read.objects} of its ${held.objects} object grants, and ` +
      'deploying that would take the rest away. Make this change in Setup, or grant the access ' +
      'through a new permission set.'
    );
  }

  return {
    path: `permissionsets/${metadataFileName(set.name)}.permissionset`,
    content: metadataFile('PermissionSet', mergePermissionSetAccess(live.metadata, changes)),
    member: { type: 'PermissionSet', member: set.name },
    precondition: {
      kind: 'component-unchanged',
      type: 'PermissionSet',
      object: '',
      name: set.name,
      fingerprint: live.fingerprint,
    },
  };
}

/**
 * A proposal's access steps, with those for a set in a permission set
 * group folded into that set's whole definition — the files, members and
 * preconditions the package gains, the steps left to run as data, and a
 * line for each set that deploys whole. Used where access rides along with
 * something else (new fields, a new object).
 */
export async function foldGroupedSteps(
  context: MCPToolContext,
  access: SalesforceAccess,
  steps: readonly DataStep[]
): Promise<
  | {
      files: Record<string, string>;
      members: PackageMember[];
      preconditions: Precondition[];
      steps: DataStep[];
      notes: string[];
    }
  | string
> {
  const files: Record<string, string> = {};
  const members: PackageMember[] = [];
  const preconditions: Precondition[] = [];
  const notes: string[] = [];
  const left: DataStep[] = [];
  const bySet = new Map<string, DataStep[]>();
  for (const step of steps) {
    bySet.set(step.permissionSetId, [...(bySet.get(step.permissionSetId) ?? []), step]);
  }
  for (const [id, own] of bySet) {
    const groups = await groupsOf(context, access, id);
    if (typeof groups === 'string') return groups;
    if (groups.length === 0) {
      left.push(...own);
      continue;
    }
    const name = own[0].permissionSetName;
    const folded = accessChangesOf(own);
    const part = await planWholeSetChange(context, access, { id, name }, folded.changes);
    if (typeof part === 'string') return part;
    files[part.path] = part.content;
    members.push(part.member);
    preconditions.push(part.precondition);
    left.push(...folded.left);
    notes.push(
      `${name} is in the permission set group ${groups.join(', ')}, where Salesforce takes no single access change: the set deploys whole, as it is now, with this access added. Everyone in the group gets it.`
    );
  }
  return { files, members, preconditions, steps: left, notes };
}
