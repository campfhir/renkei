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
import {
  SPACE_FIELD_KIND,
  describeFieldOperation,
  describeFieldReach,
  readSpaceFieldPayload,
  touchesOtherSpaces,
} from './space-field';
import {
  WORK_TYPE_KIND,
  describeWorkTypeOperation,
  describeWorkTypeReach,
  readWorkTypePayload,
  workTypeTouchesOtherSpaces,
} from './work-type';
import {
  SCREEN_CHANGES_KIND,
  describeScreenOperation,
  describeScreenReach,
  readScreenChangesPayload,
  screenTouchesOtherSpaces,
} from './screen-changes';
import {
  REQUEST_TYPE_KIND,
  describeRequestTypeOperation,
  describeRequestTypeReach,
  readRequestTypePayload,
} from './request-type';
import {
  AUTOMATION_RULE_KIND,
  AUTOMATION_RUN_KIND,
  AUTOMATION_STATE_KIND,
  describeAutomationReach,
  describeRuleOperation,
  describeRun,
  describeStateChange,
  readAutomationRulePayload,
  readAutomationRunPayload,
  readAutomationStatePayload,
} from './automation';

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
  /**
   * True when it lands beyond the spaces it names — a global context, a
   * screen other spaces show — so the page can warn.
   */
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
  if (change.kind === SPACE_FIELD_KIND) {
    const payload = readSpaceFieldPayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map((operation) =>
          describeFieldOperation(operation, payload)
        ),
        reach: describeFieldReach(payload, change.siteUrl),
        siteWide: touchesOtherSpaces(payload),
        applyNote:
          'Renkei checks first that no field of this name has appeared, that the space still ' +
          'has no context of its own, and which options and screens it already has — and ' +
          'stops at anything that has changed. A field it has created stays created. Nothing ' +
          'is deleted.',
      };
    }
  }
  if (change.kind === WORK_TYPE_KIND) {
    const payload = readWorkTypePayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map((operation) =>
          describeWorkTypeOperation(operation, payload)
        ),
        reach: describeWorkTypeReach(payload, change.siteUrl),
        siteWide: workTypeTouchesOtherSpaces(payload),
        applyNote:
          'Renkei checks first that no work type of this name has appeared and that the space ' +
          'still runs on the same schemes — and stops at anything that has changed. A work ' +
          'type it has created stays created. Nothing is deleted.',
      };
    }
  }
  if (change.kind === SCREEN_CHANGES_KIND) {
    const payload = readScreenChangesPayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map((operation) =>
          describeScreenOperation(operation, payload)
        ),
        reach: describeScreenReach(payload, change.siteUrl),
        siteWide: screenTouchesOtherSpaces(payload),
        applyNote:
          'Renkei reads the screen’s tabs and fields again first and stops at anything that has ' +
          'changed since this was proposed. A field taken off a screen keeps its values on ' +
          'every issue. Nothing is deleted.',
      };
    }
  }
  if (change.kind === REQUEST_TYPE_KIND) {
    const payload = readRequestTypePayload(change.payload);
    if (payload) {
      return {
        operations: payload.operations.map((operation) =>
          describeRequestTypeOperation(operation, payload)
        ),
        reach: describeRequestTypeReach(payload, change.siteUrl),
        siteWide: false,
        applyNote:
          'Renkei checks first that no request type of this name has appeared on the project. ' +
          'This runs on your Jira Service Management connection, not your Jira Administration ' +
          'one. Nothing is deleted.',
      };
    }
  }
  if (change.kind === AUTOMATION_STATE_KIND) {
    const payload = readAutomationStatePayload(change.payload);
    if (payload) {
      return {
        operations: payload.rules.map(describeStateChange),
        reach: describeAutomationReach(change.kind, change.siteUrl),
        siteWide: false,
        applyNote:
          'Renkei reads each rule again first; one already in that state is left alone, and one ' +
          'that is gone is reported. This runs on your Atlassian API token. Nothing is deleted.',
      };
    }
  }
  if (change.kind === AUTOMATION_RULE_KIND) {
    const payload = readAutomationRulePayload(change.payload);
    if (payload) {
      return {
        operations: [describeRuleOperation(payload)],
        reach: describeAutomationReach(change.kind, change.siteUrl),
        siteWide: payload.projects.length === 0,
        applyNote:
          payload.mode === 'create'
            ? 'Jira checks the rule’s definition when it is created; a refused one is reported ' +
              'with Jira’s reason. This runs on your Atlassian API token. Nothing is deleted.'
            : 'Renkei reads the rule again first and stops if it has been changed since this was ' +
              'proposed. This runs on your Atlassian API token. Nothing is deleted.',
      };
    }
  }
  if (change.kind === AUTOMATION_RUN_KIND) {
    const payload = readAutomationRunPayload(change.payload);
    if (payload) {
      return {
        operations: [describeRun(payload)],
        reach: describeAutomationReach(change.kind, change.siteUrl),
        siteWide: false,
        applyNote:
          'Renkei checks the rule is still enabled, then runs it once on each issue; Jira ' +
          'answers per issue. This runs on your Atlassian API token.',
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
