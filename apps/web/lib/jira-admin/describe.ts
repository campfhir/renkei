/**
 * A Jira admin change request in plain words — what it will do and where
 * it lands — for the review page and the jira_admin_list_changes tool.
 * Kept apart from ./apply so the MCP tools can describe a request without
 * importing anything that applies one.
 */

import type { ChangeRequest } from './change-requests';
import {
  FIELD_OPTIONS_KIND,
  describeOperation,
  describeReach,
  readFieldOptionsPayload,
} from './field-options';

export interface ChangeDescription {
  /** Each operation, in the order apply runs them. */
  operations: string[];
  /** Where it lands, in a sentence; null when the kind has nothing to say. */
  reach: string | null;
  /** True when it lands beyond one set of spaces — a global context — so the page can warn. */
  siteWide: boolean;
}

export function describeChange(change: Pick<ChangeRequest, 'kind' | 'payload'>): ChangeDescription {
  if (change.kind === FIELD_OPTIONS_KIND) {
    const payload = readFieldOptionsPayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map(describeOperation),
        reach: describeReach(payload),
        siteWide: payload.context.global,
      };
    }
  }
  return { operations: [], reach: null, siteWide: false };
}
