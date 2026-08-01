/**
 * Server-side endpoint allowlist. The Jira REST client refuses to issue any
 * request whose method+path doesn't match an entry here, independent of
 * OAuth scope — admin endpoints stay unreachable even if a tool is
 * misconfigured or a future tool is added carelessly.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface AllowlistEntry {
  method: HttpMethod;
  /** Path pattern with `{param}` placeholders, matched segment-by-segment. */
  pattern: string;
}

export const JIRA_ENDPOINT_ALLOWLIST: readonly AllowlistEntry[] = [
  // Health/identity
  { method: 'GET', pattern: '/rest/api/3/myself' },
  { method: 'GET', pattern: '/rest/api/3/serverInfo' },

  // Work-item read path
  { method: 'POST', pattern: '/rest/api/3/search/jql' },
  { method: 'GET', pattern: '/rest/api/3/issue/{issueKey}' },
  { method: 'GET', pattern: '/rest/api/3/issue/{issueKey}/transitions' },

  // User resolution (email → cloudId)
  { method: 'GET', pattern: '/rest/api/3/user/search' },

  // Work-item write path
  { method: 'POST', pattern: '/rest/api/3/issue' },
  { method: 'PUT', pattern: '/rest/api/3/issue/{issueKey}' },
  { method: 'POST', pattern: '/rest/api/3/issue/{issueKey}/transitions' },
  { method: 'POST', pattern: '/rest/api/3/issue/{issueKey}/comment' },
  { method: 'POST', pattern: '/rest/api/3/issue/{issueKey}/worklog' },

  // Upload only. Every path that reads an attachment back is in
  // MUST_NEVER_ALLOW below, and is reachable by the granted token.
  { method: 'POST', pattern: '/rest/api/3/issue/{issueKey}/attachments' },

  // JSM — service desk & request type discovery (read:servicedesk-request)
  { method: 'GET', pattern: '/rest/servicedeskapi/servicedesk' },
  { method: 'GET', pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/requesttype' },
  {
    method: 'GET',
    pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/requesttype/{requestTypeId}/field',
  },
  { method: 'GET', pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/requesttypegroup' },

  // Allowlisted but unusable — 401 against a live tenant, because
  // read:requesttype.property:jira-service-management is not in
  // ATLASSIAN_SCOPES. Request-type properties are instance configuration, not
  // request content, so the scope is not worth the re-consent it would force.
  // Confirmed by scripts/jsm-probe.ts.
  // { method: 'GET', pattern: '.../requesttype/{requestTypeId}/property' },
  // { method: 'GET', pattern: '.../requesttype/{requestTypeId}/property/{propertyKey}' },

  // JSM — customer request read path (read:request:jira-service-management)
  { method: 'GET', pattern: '/rest/servicedeskapi/request' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/status' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/transition' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/comment' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/comment/{commentId}' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/approval' },
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/approval/{approvalId}' },

  // SLA clocks (read:request.sla:jira-service-management). Only the collection
  // is here; `/sla/{slaMetricId}` returns one row of what this already returns
  // in full, so allowlisting it would widen the surface for nothing.
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/sla' },

  // JSM request participants (read:request.participant:jira-service-management)
  // Requires ATLASSIAN_SCOPES to include read:request.participant:jira-service-management.
  // Who can see a request is a sharing and visibility question, so enabling this
  // requires explicit operator decision.
  { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/participant' },

  // JSM — customer management (read:customer:jira-service-management, write:customer:jira-service-management)
  { method: 'GET', pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/customer' },
  { method: 'POST', pattern: '/rest/servicedeskapi/customer' },
  { method: 'POST', pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/customer' },
  { method: 'POST', pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/customer/invite' },
  { method: 'DELETE', pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/customer' },

  // JSM — customer request write path (write:request:jira-service-management)
  { method: 'POST', pattern: '/rest/servicedeskapi/request' },
  { method: 'POST', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/comment' },
  { method: 'POST', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/transition' },

  // JSM attachment upload is two calls: stage the bytes against the service
  // desk, then attach the returned temporary ID to the request. Only the
  // upload half is allowlisted — `GET .../attachment` would list and link
  // customer-supplied files, which is the same content boundary the platform
  // attachment reads are held behind.
  {
    method: 'POST',
    pattern: '/rest/servicedeskapi/servicedesk/{serviceDeskId}/attachTemporaryFile',
  },
  { method: 'POST', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/attachment' },

  // Held back deliberately — uncomment together with the matching scope in
  // ATLASSIAN_SCOPES, and note that adding a scope forces every existing user
  // to re-consent. Left in place rather than deleted so re-enabling is one
  // reviewable edit.
  //
  // Granting an approval is a governance action; the project's position is
  // that it should not be reachable by an agent under any prompt. Requires
  // write:request.approval:jira-service-management, which is not requested.
  // { method: 'POST', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/approval/{approvalId}' },
  //
  // PARTICIPANTS — OPERATOR DECISION POINT:
  // Participants list who can see a request — a sharing and visibility question.
  // If your security model permits models to read participant lists, uncomment the
  // read endpoint below AND add read:request.participant:jira-service-management to
  // ATLASSIAN_SCOPES in src/config.ts. Note: this will force re-consent from all
  // existing users.
  //
  // To enable: uncomment the GET line and add the scope.
  // { method: 'GET', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/participant' },
  //
  // Write operations (POST/DELETE) — sharing/visibility decisions
  // Add or remove participants (who can see a request).
  // Requires read:request.participant:jira-service-management scope.
  { method: 'POST', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/participant' },
  { method: 'DELETE', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/participant' },
  //
  // Notification subscription changes what Atlassian emails the customer.
  // Requires write:request.notification:jira-service-management.
  // { method: 'PUT', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/notification' },
  // { method: 'DELETE', pattern: '/rest/servicedeskapi/request/{issueIdOrKey}/notification' },

  // Attachment *download* stays out of scope for both APIs — see README
  // "Explicit non-goals". Upload is allowlisted above; every read path is
  // pinned in MUST_NEVER_ALLOW below.

  // Jira Software (Agile) — board and sprint management
  // These endpoints allow reading and modifying sprints and moving issues between them.
  { method: 'GET', pattern: '/rest/agile/1.0/board' },
  { method: 'GET', pattern: '/rest/agile/1.0/board/{boardId}/sprint' },
  { method: 'POST', pattern: '/rest/agile/1.0/sprint' },
  { method: 'POST', pattern: '/rest/agile/1.0/sprint/{sprintId}/issue' },
  { method: 'PUT', pattern: '/rest/agile/1.0/sprint/{sprintId}' },
] as const;

function segmentsMatch(patternPath: string, candidatePath: string): boolean {
  const patternSegments = patternPath.split('/').filter(Boolean);
  const candidateSegments = candidatePath.split('/').filter(Boolean);

  if (patternSegments.length !== candidateSegments.length) {
    return false;
  }

  return patternSegments.every((segment, index) => {
    const candidateSegment = candidateSegments[index] ?? '';
    if (segment.startsWith('{') && segment.endsWith('}')) {
      return candidateSegment.length > 0;
    }
    return segment === candidateSegment;
  });
}

/** Returns true only if the method+path pair exactly matches an allowlisted entry. */
export function isAllowedJiraEndpoint(method: HttpMethod, path: string): boolean {
  return JIRA_ENDPOINT_ALLOWLIST.some(
    (entry) => entry.method === method && segmentsMatch(entry.pattern, path),
  );
}

/**
 * Endpoints the granted token can reach that must never appear in the
 * allowlist above.
 *
 * The allowlist is already deny-by-default, so nothing here is *enforced* by
 * this list — it is enforced by absence. What this list does is pin the
 * decision: each entry is reachable with scopes Renkei genuinely needs for
 * something else, so "the token can't do that" is false for all of them and
 * the allowlist is the only thing standing in the way. The accompanying test
 * fails if a future change quietly adds one.
 *
 * Reachability confirmed live against a real grant by scripts/oauth-smoke.mjs.
 */
export const MUST_NEVER_ALLOW: readonly {
  method: HttpMethod;
  /** A concrete path, not a pattern — this is fed straight to isAllowedJiraEndpoint. */
  path: string;
  reason: string;
}[] = [
  {
    method: 'GET',
    path: '/rest/api/3/attachment/content/10000',
    reason:
      'raw attachment bytes. read:attachment:jira is required by write:attachment:jira, so ' +
      'granting upload grants download — verified returning HTTP 200 in the smoke run',
  },
  {
    method: 'GET',
    path: '/rest/api/3/attachment/10000',
    reason: 'attachment metadata including the content URL',
  },
  {
    method: 'GET',
    path: '/rest/api/3/attachment/thumbnail/10000',
    reason: 'rendered preview of attachment content',
  },
  {
    method: 'GET',
    path: '/rest/api/3/attachment/10000/expand/human',
    reason: 'archive listing: filenames inside an uploaded zip',
  },
  {
    method: 'GET',
    path: '/rest/api/3/attachment/10000/expand/raw',
    reason: 'archive listing: raw entry metadata inside an uploaded zip',
  },
  {
    method: 'GET',
    path: '/rest/servicedeskapi/request/SUP-1/attachment',
    reason:
      'customer-supplied attachments on a request, with download links. ' +
      'read:request.attachment:jira-service-management is required by the two-step upload, so ' +
      'the same asymmetry as the platform API applies here',
  },
  {
    method: 'GET',
    path: '/rest/api/3/field/search',
    reason:
      'instance-wide field configuration. read:field:jira is required for JQL search, so the ' +
      'scope cannot be dropped — verified returning HTTP 200 in the smoke run',
  },
  {
    method: 'GET',
    path: '/rest/api/3/group',
    reason:
      'group membership. read:group:jira is required to set comment visibility, so the scope ' +
      'cannot be dropped',
  },
] as const;
