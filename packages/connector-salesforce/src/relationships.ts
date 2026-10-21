/**
 * How two objects connect, from their describes alone: a direct lookup or
 * master-detail either way, a junction object both are parents of (a
 * many-to-many), or a shared parent. The org's own relationships, read —
 * never assumed from labels.
 */

import type { DescribeSObject } from './describe';

export type RelationshipPath =
  | {
      kind: 'lookup';
      /** `from.<field>` points at `to`. */
      field: string;
      relationshipName: string | null;
      description: string;
    }
  | {
      kind: 'children';
      /** `to.<field>` points at `from`; `from`'s child relationship is `relationshipName`. */
      field: string;
      relationshipName: string | null;
      description: string;
    }
  | {
      kind: 'junction';
      junctionObject: string;
      /** The junction's field pointing at `from`. */
      fromField: string;
      /** The junction's field pointing at `to`. */
      toField: string;
      description: string;
    }
  | {
      kind: 'shared-parent';
      parentObject: string;
      fromField: string;
      toField: string;
      description: string;
    };

export function findRelationshipPaths(
  from: DescribeSObject,
  to: DescribeSObject
): RelationshipPath[] {
  const paths: RelationshipPath[] = [];

  for (const field of from.fields) {
    if (field.type === 'reference' && (field.referenceTo ?? []).includes(to.name)) {
      paths.push({
        kind: 'lookup',
        field: field.name,
        relationshipName: field.relationshipName ?? null,
        description: `Each ${from.label} points at one ${to.label} through ${from.name}.${field.name}${
          field.relationshipName ? ` (query as ${field.relationshipName}.<field>)` : ''
        }.`,
      });
    }
  }

  for (const rel of from.childRelationships ?? []) {
    if (rel.childSObject === to.name) {
      paths.push({
        kind: 'children',
        field: rel.field,
        relationshipName: rel.relationshipName,
        description: `A ${from.label} has many ${to.labelPlural ?? to.label} through ${to.name}.${rel.field}${
          rel.relationshipName ? ` (subquery FROM ${rel.relationshipName})` : ''
        }${rel.cascadeDelete ? '; they are deleted with it' : ''}.`,
      });
    }
  }

  // A junction: an object that is a child of both.
  const fromChildren = new Map<string, string[]>();
  for (const rel of from.childRelationships ?? []) {
    if (rel.childSObject === to.name || rel.childSObject === from.name) continue;
    fromChildren.set(rel.childSObject, [...(fromChildren.get(rel.childSObject) ?? []), rel.field]);
  }
  for (const rel of to.childRelationships ?? []) {
    const fromFields = fromChildren.get(rel.childSObject);
    if (!fromFields) continue;
    for (const fromField of fromFields) {
      paths.push({
        kind: 'junction',
        junctionObject: rel.childSObject,
        fromField,
        toField: rel.field,
        description: `${from.labelPlural ?? from.label} and ${to.labelPlural ?? to.label} relate many-to-many through ${rel.childSObject} (${rel.childSObject}.${fromField} → ${from.name}, ${rel.childSObject}.${rel.field} → ${to.name}).`,
      });
    }
  }

  // A shared parent: both point at the same third object.
  const fromParents = new Map<string, string>();
  for (const field of from.fields) {
    if (
      field.type !== 'reference' ||
      field.name === 'OwnerId' ||
      /^(Created|LastModified)ById$/.test(field.name)
    )
      continue;
    for (const target of field.referenceTo ?? []) {
      if (target !== to.name && !fromParents.has(target)) fromParents.set(target, field.name);
    }
  }
  for (const field of to.fields) {
    if (
      field.type !== 'reference' ||
      field.name === 'OwnerId' ||
      /^(Created|LastModified)ById$/.test(field.name)
    )
      continue;
    for (const target of field.referenceTo ?? []) {
      const fromField = fromParents.get(target);
      if (fromField && target !== from.name) {
        paths.push({
          kind: 'shared-parent',
          parentObject: target,
          fromField,
          toField: field.name,
          description: `Both point at a ${target}: ${from.name}.${fromField} and ${to.name}.${field.name} — "this ${from.label}'s ${to.labelPlural ?? to.label}" can mean those with the same ${target}.`,
        });
      }
    }
  }

  return paths;
}
