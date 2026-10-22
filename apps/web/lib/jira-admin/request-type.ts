/**
 * A request type for a service project — the sixth kind of change request,
 * and the one that runs on a DIFFERENT grant. Creating a request type is a
 * Jira Service Management call (POST /servicedesk/{id}/requesttype), which
 * Atlassian documents under the granular scope
 * write:requesttype:jira-service-management only — and the Jira
 * Administration app is classic, which one app cannot mix with. So the
 * proposal reads the space on the Jira Administration grant, reads and
 * writes the service desk on the person's Jira Service Management grant,
 * and is offered only to someone holding both (jira-admin/index.ts). The
 * confirm rule is unchanged: nothing on the MCP surface writes, and the
 * apply route sends the one create on the JSM grant.
 *
 * Jira gives a new request type the headset icon, no portal group (so it
 * is hidden on the portal until an admin groups it in Project settings)
 * and the work type's fields; the API offers no way to change any of
 * those, and the review page says so.
 */

import {
  jiraAdminGet,
  jiraAdminSend,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';
import type { OperationResult } from './change-requests';

export const REQUEST_TYPE_KIND = 'request_type';

/** The granular scopes, on the JSM grant, that proposing and applying stand on. */
export const REQUEST_TYPE_JSM_SCOPES = [
  'read:servicedesk:jira-service-management',
  'read:requesttype:jira-service-management',
  'write:requesttype:jira-service-management',
] as const;

interface LogScope {
  subject?: string;
}

export interface CreateRequestTypeOperation {
  op: 'create_request_type';
  name: string;
  description: string | null;
  helpText: string | null;
  workType: { id: string; name: string };
}

export interface RequestTypePayload {
  serviceDesk: { id: string; projectId: string; projectKey: string; projectName: string };
  operations: CreateRequestTypeOperation[];
}

// ---- describing --------------------------------------------------------------

export interface DescribedRequestTypeOperation {
  text: string;
  access: boolean;
  details: string[];
}

export function describeRequestTypeOperation(
  operation: CreateRequestTypeOperation,
  payload: Pick<RequestTypePayload, 'serviceDesk'>
): DescribedRequestTypeOperation {
  return {
    text:
      `Add the request type “${operation.name}” to ${payload.serviceDesk.projectKey}, backed by ` +
      `the work type “${operation.workType.name}”`,
    access: false,
    details: [
      ...(operation.description ? [`Description: ${operation.description}`] : []),
      ...(operation.helpText ? [`Help text: ${operation.helpText}`] : []),
      'It gets the headset icon and the work type’s fields, and stays hidden on the portal ' +
        'until an admin puts it in a portal group (Project settings → Request types) — Jira’s ' +
        'API sets none of those.',
    ],
  };
}

export function describeRequestTypeReach(
  payload: RequestTypePayload,
  siteUrl: string | null
): string {
  const desk = payload.serviceDesk;
  return (
    `The service project ${desk.projectKey}${desk.projectName ? ` (${desk.projectName})` : ''}` +
    `${siteUrl ? ` on ${siteUrl}` : ''} and its customer portal. A request type is the ` +
    'project’s own. Applying runs on your Jira Service Management connection.'
  );
}

/** "New request type “Report an outage” for OPS" — a list row's title. */
export function requestTypeTitle(payload: RequestTypePayload): string {
  const first = payload.operations[0];
  const title = first
    ? `New request type “${first.name}” for ${payload.serviceDesk.projectKey}`
    : `Request types for ${payload.serviceDesk.projectKey}`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading ---------------------------------------------------------------

function readOperation(value: unknown): CreateRequestTypeOperation | null {
  const record = rec(value);
  if (record.op !== 'create_request_type') return null;
  const workType = rec(record.workType);
  if (!str(record.name) || !str(workType.id)) return null;
  return {
    op: 'create_request_type',
    name: str(record.name),
    description: str(record.description) || null,
    helpText: str(record.helpText) || null,
    workType: { id: str(workType.id), name: str(workType.name) },
  };
}

/** The payload as stored, or null when it is not one this code wrote in full. */
export function readRequestTypePayload(value: unknown): RequestTypePayload | null {
  const record = rec(value);
  const desk = rec(record.serviceDesk);
  if (!str(desk.id) || !str(desk.projectKey)) return null;
  if (!Array.isArray(record.operations) || record.operations.length === 0) return null;
  const operations: CreateRequestTypeOperation[] = [];
  for (const item of record.operations) {
    const operation = readOperation(item);
    if (!operation) return null;
    operations.push(operation);
  }
  return {
    serviceDesk: {
      id: str(desk.id),
      projectId: str(desk.projectId),
      projectKey: str(desk.projectKey),
      projectName: str(desk.projectName),
    },
    operations,
  };
}

// ---- the desk as it is -------------------------------------------------------

export interface RequestTypeRecord {
  id: string;
  name: string;
  issueTypeId: string;
}

/** A service desk's request types, hidden ones included, by name search or all. */
export async function readRequestTypes(
  scope: LogScope,
  jsm: JiraAdminAccess,
  serviceDeskId: string,
  query?: string
): Promise<{ ok: true; requestTypes: RequestTypeRecord[] } | { ok: false; error: string }> {
  const result = await jiraAdminGet(
    scope,
    jsm,
    `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/requesttype` +
      `?limit=100&includeHiddenRequestTypesInSearch=true` +
      (query ? `&searchQuery=${encodeURIComponent(query)}` : '')
  );
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    requestTypes: records(result.body).map((type) => ({
      id: str(type.id),
      name: str(type.name),
      issueTypeId: str(type.issueTypeId),
    })),
  };
}

// ---- applying ----------------------------------------------------------------

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Apply a stored request type proposal on the JSM grant, in order,
 * stopping at the first operation that fails.
 */
export async function applyRequestType(
  scope: LogScope,
  jsm: JiraAdminAccess,
  payload: RequestTypePayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  let stopped = false;
  for (const operation of payload.operations) {
    const label = describeRequestTypeOperation(operation, payload).text;
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    const held = await readRequestTypes(scope, jsm, payload.serviceDesk.id, operation.name);
    if (!held.ok) {
      results.push({
        label,
        outcome: 'failed',
        detail: `Checking the name is free: ${held.error}`,
      });
      stopped = true;
      continue;
    }
    const taken = held.requestTypes.find((type) => same(type.name, operation.name));
    if (taken) {
      results.push({
        label,
        outcome: 'failed',
        detail:
          `A request type named “${taken.name}” is on ${payload.serviceDesk.projectKey} now ` +
          `(${taken.id}), so another was not added.`,
      });
      stopped = true;
      continue;
    }
    const created = await jiraAdminSend(
      scope,
      jsm,
      'POST',
      `/rest/servicedeskapi/servicedesk/${encodeURIComponent(payload.serviceDesk.id)}/requesttype`,
      {
        name: operation.name,
        issueTypeId: operation.workType.id,
        ...(operation.description ? { description: operation.description } : {}),
        ...(operation.helpText ? { helpText: operation.helpText } : {}),
      },
      { headers: { 'X-ExperimentalApi': 'opt-in' } }
    );
    if (!created.ok) {
      results.push({ label, outcome: 'failed', detail: created.error });
      stopped = true;
      continue;
    }
    const id = str(rec(created.body).id);
    results.push({
      label,
      outcome: 'done',
      detail:
        (id ? `Created as ${id}. ` : '') +
        'Hidden on the portal until it is put in a portal group in Project settings.',
    });
  }
  const done = results.filter((result) => result.outcome === 'done').length;
  return {
    status: done === results.length ? 'applied' : done === 0 ? 'failed' : 'partial',
    results,
  };
}
