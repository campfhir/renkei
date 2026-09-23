/**
 * A Jira admin change request in plain words — what it will do and where
 * it lands — for the review page and the jira_admin_ tools. Kept apart
 * from ./apply so the MCP tools can describe a request without importing
 * anything that applies one.
 */

import type { ChangeRequest } from './change-requests';
import {
  FIELD_OPTIONS_KIND,
  describeOperation,
  describeReach,
  readFieldOptionsPayload,
} from './field-options';
import {
  CREATE_SPACE_KIND,
  describeSpaceOperation,
  describeSpaceReach,
  readCreateSpacePayload,
} from './space-creation';

export interface DescribedOperation {
  text: string;
  /**
   * Changes who can see or do what — role members, a permission scheme —
   * which the review page labels, since those are the changes people most
   * need to notice (docs/project-management-design.md, "Guardrails").
   */
  access: boolean;
  /** Lines under the operation: the schemes a new space runs on, say. */
  details: string[];
}

export interface ChangeDescription {
  /** Each operation, in the order apply runs them. */
  operations: DescribedOperation[];
  /** Where it lands, in a sentence; null when the kind has nothing to say. */
  reach: string | null;
  /** True when it lands beyond one set of spaces — a global context — so the page can warn. */
  siteWide: boolean;
  /** What applying re-checks and how it stops, for the line beside the Apply button. */
  applyNote: string | null;
}

export function describeChange(
  change: Pick<ChangeRequest, 'kind' | 'payload' | 'siteUrl'>
): ChangeDescription {
  if (change.kind === FIELD_OPTIONS_KIND) {
    const payload = readFieldOptionsPayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map((operation) => ({
          text: describeOperation(operation),
          access: false,
          details: [],
        })),
        reach: describeReach(payload),
        siteWide: payload.context.global,
        applyNote:
          'Renkei reads the field again first and stops at anything that has changed since ' +
          'this was proposed. Nothing is deleted.',
      };
    }
  }
  if (change.kind === CREATE_SPACE_KIND) {
    const payload = readCreateSpacePayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map((operation) =>
          describeSpaceOperation(operation, payload)
        ),
        reach: describeSpaceReach(payload, change.siteUrl),
        siteWide: false,
        applyNote:
          'Renkei checks the key is still free first, and stops at the first step Jira ' +
          'refuses — a space it has created stays created, and the results say which roles ' +
          'were set. Nothing is deleted.',
      };
    }
  }
  return { operations: [], reach: null, siteWide: false, applyNote: null };
}

/** The operations as text lines for a tool result: access changes marked, details indented. */
export function operationLines(operations: DescribedOperation[]): string[] {
  return operations.flatMap((operation) => [
    `• ${operation.access ? '[access] ' : ''}${operation.text}`,
    ...operation.details.map((detail) => `    ${detail}`),
  ]);
}
