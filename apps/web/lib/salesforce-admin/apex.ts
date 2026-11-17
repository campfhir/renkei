/**
 * Apex as an org holds it, for the change requests that write it: one
 * class or trigger read live (the org's own, not a package's), and the
 * hash a proposal records of it so applying stops when someone changed it
 * since (plan.ts, `apex-unchanged`).
 */

import {
  APEX_OBJECT,
  HIDDEN_BODY,
  soqlString,
  type ApexStatus,
  type ApexUnit,
} from '@renkei/connector-salesforce';
import {
  sfQuery,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
} from '@/lib/mcp-tools/salesforce/client';
import { fingerprintOf } from './tooling';

export const APEX_KIND = 'apex';

export interface LiveApex extends ApexUnit {
  id: string;
  body: string;
  apiVersion: string;
  status: ApexStatus;
  /** The object a trigger is on. */
  object?: string;
  fingerprint: string;
}

/** What a proposal records of a class or trigger: its source and whether it is on. */
export function apexFingerprint(body: string, status: string): string {
  return fingerprintOf({ body, status });
}

/** One class or trigger of the org's own by name; null when it has none; why not, as text. */
export async function readLiveApex(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  unit: ApexUnit
): Promise<LiveApex | null | string> {
  const extra = unit.kind === 'trigger' ? ', TableEnumOrId' : '';
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, ApiVersion, Status, Body${extra} FROM ${APEX_OBJECT[unit.kind]} ` +
      `WHERE Name = ${soqlString(unit.name)} AND NamespacePrefix = null LIMIT 1`
  );
  if (!found.ok) return found.error;
  const row = found.records[0];
  if (!row) return null;
  const body = str(row.Body);
  if (body === HIDDEN_BODY) return `Salesforce does not show the source of ${unit.name}.`;
  const status: ApexStatus = str(row.Status) === 'Inactive' ? 'Inactive' : 'Active';
  const apiVersion = str(row.ApiVersion);
  return {
    kind: unit.kind,
    name: str(row.Name) || unit.name,
    id: str(row.Id),
    body,
    // The REST API sends 62 for 62.0; the meta file wants the decimal.
    apiVersion: apiVersion && !apiVersion.includes('.') ? `${apiVersion}.0` : apiVersion,
    status,
    ...(unit.kind === 'trigger' && str(row.TableEnumOrId)
      ? { object: str(row.TableEnumOrId) }
      : {}),
    fingerprint: apexFingerprint(body, status),
  };
}
