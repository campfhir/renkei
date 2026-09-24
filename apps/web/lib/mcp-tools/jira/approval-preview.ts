/**
 * The issue-preview widget's `structuredContent` for an agent approval
 * card — the one place that turns a `jira_create_issue`/`jira_update_issue`
 * call's raw arguments into the SAME rich card chat's own preview tools
 * render (write.ts), typed fields included: a resolved picklist becomes a
 * dropdown, a resolved multi-select becomes checkboxes, a number field
 * becomes a number input. Everything else about the call (project, type,
 * which issue) is read-only — see issue-preview.ts's own header comment
 * for why.
 *
 * Field TYPES come from a live, best-effort fetch (approval-field-schema.ts)
 * — this module never fails the render if that fetch fails or Jira is not
 * connected; every field just falls back to a plain text box instead of a
 * typed control, same as before this existed.
 */

import { renderFieldValue } from './fields';
import { lookupField, type JiraField } from './field-schema';
import { loadApprovalFieldSchema } from './approval-field-schema';
import { ISSUE_PREVIEW_URI, newPreviewId } from '../widgets';

type EditKind = 'text' | 'text-array' | 'number' | 'select' | 'checkboxes';

interface EditableFieldOption {
  label: string;
  value: string;
}

interface EditableFieldRow {
  label: string;
  value: string;
  editable: {
    path: string[];
    kind: EditKind;
    value: string | string[];
    options: EditableFieldOption[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resolveField(schema: JiraField[] | null, reference: string): JiraField | undefined {
  if (!schema) return undefined;
  const found = lookupField(schema, reference);
  return found.ok ? found.field : undefined;
}

/** What control a field's schema calls for, given whether the value it
 * already holds is itself array-shaped (labels, an unresolved multi-value
 * custom field): unresolved or non-option-bearing still needs SOME control,
 * and an array value can't go in a plain text-array box. */
function controlKindFor(
  field: JiraField | undefined,
  isArrayValue: boolean
): { kind: EditKind; options: EditableFieldOption[] } {
  if (field?.type === 'number') return { kind: 'number', options: [] };
  const options = (field?.allowedValues ?? []).map((option) => ({
    label: option.value,
    value: option.value,
  }));
  if (field?.type === 'option' && options.length > 0) return { kind: 'select', options };
  if (
    field?.type === 'array' &&
    (field.itemType === 'option' ||
      field.itemType === 'component' ||
      field.itemType === 'version') &&
    options.length > 0
  ) {
    return { kind: 'checkboxes', options };
  }
  return { kind: isArrayValue ? 'text-array' : 'text', options: [] };
}

function editableRow(
  label: string,
  path: string[],
  rawValue: unknown,
  field: JiraField | undefined
): EditableFieldRow {
  const isArrayValue = Array.isArray(rawValue);
  const displayValue =
    renderFieldValue(rawValue) ||
    (isArrayValue ? '' : typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue));
  const control = controlKindFor(field, isArrayValue);
  const controlValue: string | string[] =
    control.kind === 'checkboxes'
      ? isArrayValue
        ? rawValue.map(String)
        : typeof rawValue === 'string'
          ? [rawValue]
          : []
      : control.kind === 'number'
        ? String(typeof rawValue === 'number' ? rawValue : (rawValue ?? ''))
        : isArrayValue
          ? rawValue.map(String).join(', ')
          : typeof rawValue === 'string'
            ? rawValue
            : String(rawValue ?? '');
  return {
    label,
    value: displayValue,
    editable: { path, kind: control.kind, value: controlValue, options: control.options },
  };
}

/**
 * Display+edit rows for a `jira_create_issue`/`jira_update_issue` call,
 * out of its own arguments plus (when resolved) each field's live schema.
 * A field this resolves nothing for still gets a row — just editable as
 * plain text, the same as every field was before this existed.
 */
export function approvalFieldRows(
  args: Record<string, unknown>,
  schema: JiraField[] | null
): EditableFieldRow[] {
  const rows: EditableFieldRow[] = [];
  const asString = (value: unknown) => (typeof value === 'string' ? value : '');

  if (asString(args.priority)) {
    rows.push(
      editableRow('Priority', ['priority'], args.priority, resolveField(schema, 'Priority'))
    );
  }
  if (asString(args.assignee)) {
    rows.push(
      editableRow('Assignee', ['assignee'], args.assignee, resolveField(schema, 'Assignee'))
    );
  }
  if (Array.isArray(args.labels) && args.labels.length > 0) {
    rows.push(editableRow('Labels', ['labels'], args.labels, resolveField(schema, 'Labels')));
  }
  if (Array.isArray(args.components) && args.components.length > 0) {
    rows.push(
      editableRow(
        'Components',
        ['components'],
        args.components,
        resolveField(schema, 'Component/s')
      )
    );
  }
  if (typeof args.storyPoints === 'number') {
    // Always a number by definition — no schema lookup needed to know that.
    rows.push({
      label: 'Story points',
      value: String(args.storyPoints),
      editable: {
        path: ['storyPoints'],
        kind: 'number',
        value: String(args.storyPoints),
        options: [],
      },
    });
  }
  if (asString(args.originalEstimate)) {
    // A duration string ("3d 4h"), not a schema-typed field.
    const originalEstimate = asString(args.originalEstimate);
    rows.push({
      label: 'Original estimate',
      value: originalEstimate,
      editable: { path: ['originalEstimate'], kind: 'text', value: originalEstimate, options: [] },
    });
  }
  if (isRecord(args.fields)) {
    for (const [name, value] of Object.entries(args.fields)) {
      rows.push(editableRow(name, ['fields', name], value, resolveField(schema, name)));
    }
  }
  return rows;
}

/** `jira_create_issue`/`jira_update_issue` — the only two a `needsApproval`
 * gate ever proposes directly (their `_preview`/`_confirm` twins are for
 * chat's own in-turn card, never a step's `tool`). */
const APPROVAL_WIDGET_TOOLS = new Set(['jira_create_issue', 'jira_update_issue']);

/**
 * Never a real MCP tool — just what the card's Cancel button calls instead
 * of finishing locally (issue-preview.ts's `cancelTool`), so the host
 * (ApprovalWidgetCard) sees a `tools/call` it can tell apart from Confirm's
 * by name. What actually decides `decision: 'approve' | 'decline'` there is
 * `confirmOutcome`/`cancelOutcome` below, not this string.
 */
const DECLINE_TOOL = 'renkei.approval.decline';

/**
 * The issue-preview widget's `structuredContent`, built from a
 * `jira_create_issue`/`jira_update_issue` call's own arguments, enriched
 * with a live (but best-effort — never fatal) field-schema fetch so a
 * picklist/multi-select/number field renders and edits as one instead of
 * plain text. `confirmTool` names the gated tool itself — whichever card
 * renders this never actually calls it as an MCP tool; hosting it outside
 * chat means routing that confirm somewhere else entirely (an approval
 * decision, not a live tool call).
 *
 * Returns null for any tool this shape does not cover — the caller's
 * signal to fall back to a plainer rendering instead of a widget.
 */
export async function jiraIssueApprovalPreview(
  tool: string,
  args: Record<string, unknown>,
  tenantId: string,
  subject: string
): Promise<{ resourceUri: string; structuredContent: Record<string, unknown> } | null> {
  if (!APPROVAL_WIDGET_TOOLS.has(tool)) return null;
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const projectKey = str(args.projectKey);
  const issueType = str(args.issueType);
  const issueKey = str(args.issueKey);
  const subtitle = [projectKey, issueType].filter(Boolean).join(' · ') || issueKey;

  const schema = await loadApprovalFieldSchema(
    tenantId,
    subject,
    tool === 'jira_create_issue' ? { projectKey, issueType } : { issueKey }
  );

  return {
    resourceUri: ISSUE_PREVIEW_URI,
    structuredContent: {
      kind: 'issue',
      previewId: newPreviewId(),
      title: tool === 'jira_create_issue' ? 'Create Jira issue' : `Update ${issueKey}`,
      ...(subtitle ? { subtitle } : {}),
      confirmTool: tool,
      confirmLabel: tool === 'jira_create_issue' ? 'Create' : 'Update',
      confirmOutcome: 'approved',
      // Cancel IS the decline here — one button, not a second "no" control
      // duplicating it outside the card (see approval-widget-card.tsx).
      cancelTool: DECLINE_TOOL,
      cancelLabel: 'Decline',
      cancelOutcome: 'declined',
      confirmArgs: args,
      // Create always shows both — summary is required, and description is
      // worth offering even when the call did not propose one. Update only
      // offers editing a field the call is already touching, same as the
      // real jira_update_issue_preview.
      editable:
        tool === 'jira_create_issue'
          ? { summaryKey: 'summary', descriptionKey: 'description' }
          : {
              ...(str(args.summary) ? { summaryKey: 'summary' } : {}),
              ...(str(args.description) ? { descriptionKey: 'description' } : {}),
            },
      fields: approvalFieldRows(args, schema),
    },
  };
}
