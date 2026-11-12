/**
 * A permission set and the permission set groups it is in, and the one
 * change that has no access row to write: record types.
 *
 * Access in an existing set is data — one FieldPermissions,
 * ObjectPermissions or tab-setting row per step — whether or not the set is
 * in a group; a set in a group is changed like any other, and the group
 * picks the change up. (The group itself is not: it has a permission set
 * row of its own that Salesforce derives and will not let anyone write —
 * resolvePermissionSet tells it apart and names the group's sets.)
 *
 * Record types have no row, so for those the set deploys whole: read with
 * readMetadata, the record types added, deployed, and refused on apply if
 * the set moved since. A whole deploy replaces the set, so it is only as
 * safe as the read: the definition read is checked against the access rows
 * the set has, and a read that holds fewer grants than the org does is not
 * deployed.
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
import type { Precondition } from '@/lib/salesforce-admin/plan';
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
