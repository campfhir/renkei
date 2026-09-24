/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The issue-preview widget's structuredContent for an approval card: which
 * tools get one at all, the header/editable-key shape (unchanged from
 * before the widget grew typed fields), and — the new part —
 * approvalFieldRows' classification of each field into a text/text-array/
 * number/select/checkboxes control from a (possibly absent) live schema.
 */

let resolvedSchema: unknown = null;
jest.mock('./approval-field-schema', () => ({
  loadApprovalFieldSchema: async () => resolvedSchema,
}));

import { approvalFieldRows, jiraIssueApprovalPreview } from './approval-preview';
import type { JiraField } from './field-schema';
import { ISSUE_PREVIEW_URI } from '../widgets';

beforeEach(() => {
  resolvedSchema = null;
});

const field = (
  overrides: Partial<JiraField> & Pick<JiraField, 'id' | 'name' | 'type'>
): JiraField => ({
  custom: true,
  clauseNames: [],
  ...overrides,
});

describe('approvalFieldRows', () => {
  it('falls back to a plain text row for every field when no schema resolved', () => {
    const rows = approvalFieldRows(
      { priority: 'High', labels: ['a', 'b'], fields: { 'Anti-Kickback Review': 'Required' } },
      null
    );
    expect(rows).toEqual([
      {
        label: 'Priority',
        value: 'High',
        editable: { path: ['priority'], kind: 'text', value: 'High', options: [] },
      },
      {
        label: 'Labels',
        value: 'a, b',
        editable: { path: ['labels'], kind: 'text-array', value: 'a, b', options: [] },
      },
      {
        label: 'Anti-Kickback Review',
        value: 'Required',
        editable: {
          path: ['fields', 'Anti-Kickback Review'],
          kind: 'text',
          value: 'Required',
          options: [],
        },
      },
    ]);
  });

  it('renders a resolved single-select field as a dropdown with its real options', () => {
    const schema: JiraField[] = [
      field({
        id: 'priority',
        name: 'Priority',
        type: 'option',
        allowedValues: [{ value: 'High' }, { value: 'Medium' }, { value: 'Low' }],
      }),
    ];
    const rows = approvalFieldRows({ priority: 'High' }, schema);
    expect(rows[0]?.editable).toEqual({
      path: ['priority'],
      kind: 'select',
      value: 'High',
      options: [
        { label: 'High', value: 'High' },
        { label: 'Medium', value: 'Medium' },
        { label: 'Low', value: 'Low' },
      ],
    });
  });

  it('renders a resolved multi-select/component field as checkboxes', () => {
    const schema: JiraField[] = [
      field({
        id: 'components',
        name: 'Component/s',
        type: 'array',
        itemType: 'component',
        allowedValues: [{ value: 'Backend' }, { value: 'Frontend' }, { value: 'Infra' }],
      }),
    ];
    const rows = approvalFieldRows({ components: ['Backend'] }, schema);
    expect(rows[0]?.editable).toEqual({
      path: ['components'],
      kind: 'checkboxes',
      value: ['Backend'],
      options: [
        { label: 'Backend', value: 'Backend' },
        { label: 'Frontend', value: 'Frontend' },
        { label: 'Infra', value: 'Infra' },
      ],
    });
  });

  it('renders a resolved number custom field with a number control', () => {
    const schema: JiraField[] = [
      field({ id: 'customfield_10016', name: 'Story Points (custom)', type: 'number' }),
    ];
    const rows = approvalFieldRows({ fields: { 'Story Points (custom)': 8 } }, schema);
    expect(rows[0]?.editable).toEqual({
      path: ['fields', 'Story Points (custom)'],
      kind: 'number',
      value: '8',
      options: [],
    });
  });

  it('always treats storyPoints as a number, without needing schema resolution', () => {
    const rows = approvalFieldRows({ storyPoints: 5 }, null);
    expect(rows[0]).toEqual({
      label: 'Story points',
      value: '5',
      editable: { path: ['storyPoints'], kind: 'number', value: '5', options: [] },
    });
  });
});

describe('jiraIssueApprovalPreview', () => {
  it('returns null for a tool a needsApproval gate never proposes directly', async () => {
    expect(await jiraIssueApprovalPreview('jira_add_comment', {}, 't1', 'alice')).toBeNull();
    // The chat-only twins — a step's `tool` never references these.
    expect(
      await jiraIssueApprovalPreview('jira_create_issue_preview', {}, 't1', 'alice')
    ).toBeNull();
    expect(
      await jiraIssueApprovalPreview('jira_create_issue_confirm', {}, 't1', 'alice')
    ).toBeNull();
  });

  it('builds the same issue-preview widget shape for a create call', async () => {
    const preview = await jiraIssueApprovalPreview(
      'jira_create_issue',
      {
        projectKey: 'CIO',
        issueType: 'Project',
        summary: 'Salesforce Incentive-Program Tracking',
        fields: { 'Anti-Kickback Review': 'Required' },
      },
      't1',
      'alice'
    );
    expect(preview?.resourceUri).toBe(ISSUE_PREVIEW_URI);
    expect(preview?.structuredContent).toMatchObject({
      kind: 'issue',
      title: 'Create Jira issue',
      subtitle: 'CIO · Project',
      confirmTool: 'jira_create_issue',
      confirmLabel: 'Create',
      confirmOutcome: 'approved',
      editable: { summaryKey: 'summary', descriptionKey: 'description' },
    });
    // Cancel doubles as decline — a distinct tool name (never a real MCP
    // tool) so the host can tell it apart from Confirm, and an explicit
    // outcome tag so it does not have to know that name to do so.
    expect(preview?.structuredContent.cancelTool).toBeTruthy();
    expect(preview?.structuredContent.cancelTool).not.toBe('jira_create_issue');
    expect(preview?.structuredContent.cancelLabel).toBe('Decline');
    expect(preview?.structuredContent.cancelOutcome).toBe('declined');
    // The confirm button's args are the call's own, verbatim — nothing
    // resolved or stripped, so a round-trip through the card changes only
    // what the person actually edited.
    expect(preview?.structuredContent.confirmArgs).toEqual({
      projectKey: 'CIO',
      issueType: 'Project',
      summary: 'Salesforce Incentive-Program Tracking',
      fields: { 'Anti-Kickback Review': 'Required' },
    });
    // Every previewId is fresh — no stale "already decided" receipt from a
    // localStorage lookup keyed off a repeated id.
    const again = await jiraIssueApprovalPreview(
      'jira_create_issue',
      { projectKey: 'CIO' },
      't1',
      'alice'
    );
    expect(preview?.structuredContent.previewId).not.toBe(again?.structuredContent.previewId);
  });

  it('only offers editing the fields an update call is already touching', async () => {
    const preview = await jiraIssueApprovalPreview(
      'jira_update_issue',
      { issueKey: 'CIO-51', summary: 'New summary' },
      't1',
      'alice'
    );
    expect(preview?.structuredContent).toMatchObject({
      title: 'Update CIO-51',
      subtitle: 'CIO-51',
      confirmTool: 'jira_update_issue',
      confirmLabel: 'Update',
      editable: { summaryKey: 'summary' },
    });
    // description was never part of this update, so there is nothing to
    // offer editing — matches jira_update_issue_preview's own behavior.
    expect(preview?.structuredContent.editable).not.toHaveProperty('descriptionKey');
  });

  it('passes a resolved schema through to typed field rows', async () => {
    resolvedSchema = [
      field({
        id: 'priority',
        name: 'Priority',
        type: 'option',
        allowedValues: [{ value: 'High' }, { value: 'Low' }],
      }),
    ] satisfies JiraField[];
    const preview = await jiraIssueApprovalPreview(
      'jira_create_issue',
      { projectKey: 'CIO', issueType: 'Project', summary: 'x', priority: 'High' },
      't1',
      'alice'
    );
    const rows = preview?.structuredContent.fields as { editable?: { kind: string } }[];
    expect(rows?.[0]?.editable?.kind).toBe('select');
  });
});
