import { jiraIssueApprovalPreview, normalizeFieldId, renderFieldValue } from './fields';
import { ISSUE_PREVIEW_URI } from '../widgets';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const paragraph = (value: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});

describe('renderFieldValue', () => {
  it('never yields [object Object] for an ADF description', () => {
    const rendered = renderFieldValue(doc(paragraph('Deploy the schema change.')));
    expect(rendered).toBe('Deploy the schema change.');
    expect(rendered).not.toContain('[object Object]');
  });

  it('keeps the markdown the renderer produces', () => {
    const rendered = renderFieldValue(
      doc({ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('step one')] }] })
    );
    expect(rendered).toBe('- step one');
  });

  it('unwraps a select field to its value', () => {
    expect(renderFieldValue({ self: 'https://x.test/f/1', value: 'Approved', id: '10201' })).toBe(
      'Approved'
    );
  });

  it('joins the two levels of a cascading select', () => {
    expect(renderFieldValue({ value: 'Infrastructure', child: { value: 'Network' } })).toBe(
      'Infrastructure → Network'
    );
  });

  it('unwraps users, and the shared name shape', () => {
    expect(renderFieldValue({ accountId: 'abc', displayName: 'Dana Lin' })).toBe('Dana Lin');
    expect(renderFieldValue({ name: 'In Progress', id: '3' })).toBe('In Progress');
  });

  it('comma-joins arrays of options', () => {
    expect(renderFieldValue([{ value: 'Low' }, { value: 'Reversible' }])).toBe('Low, Reversible');
  });

  it('bullets arrays whose members span lines', () => {
    const multi = doc(paragraph('one'), paragraph('two'));
    expect(renderFieldValue([multi, 'plain'])).toBe('- one\n\ntwo\n- plain');
  });

  it('passes through scalars and drops empties', () => {
    expect(renderFieldValue('  spaced  ')).toBe('spaced');
    expect(renderFieldValue(7)).toBe('7');
    expect(renderFieldValue(false)).toBe('false');
    expect(renderFieldValue(null)).toBe('');
    expect(renderFieldValue(undefined)).toBe('');
    expect(renderFieldValue([])).toBe('');
  });

  it('shows the raw payload for a shape it does not recognise', () => {
    const rendered = renderFieldValue({ originalEstimateSeconds: 3600, remaining: null });
    expect(rendered).toContain('originalEstimateSeconds');
    expect(rendered).not.toContain('[object Object]');
  });
});

describe('normalizeFieldId', () => {
  it('expands a bare custom field number', () => {
    expect(normalizeFieldId('12013')).toBe('customfield_12013');
  });

  it('expands the JQL cf[] spelling', () => {
    expect(normalizeFieldId('cf[12016]')).toBe('customfield_12016');
    expect(normalizeFieldId('CF[12016]')).toBe('customfield_12016');
  });

  it('leaves ids and system field names alone', () => {
    expect(normalizeFieldId('customfield_12013')).toBe('customfield_12013');
    expect(normalizeFieldId(' labels ')).toBe('labels');
    expect(normalizeFieldId('*all')).toBe('*all');
  });
});

describe('jiraIssueApprovalPreview', () => {
  it('returns null for a tool a needsApproval gate never proposes directly', () => {
    expect(jiraIssueApprovalPreview('jira_add_comment', {})).toBeNull();
    // The chat-only twins — a step's `tool` never references these.
    expect(jiraIssueApprovalPreview('jira_create_issue_preview', {})).toBeNull();
    expect(jiraIssueApprovalPreview('jira_create_issue_confirm', {})).toBeNull();
  });

  it('builds the same issue-preview widget shape for a create call', () => {
    const preview = jiraIssueApprovalPreview('jira_create_issue', {
      projectKey: 'CIO',
      issueType: 'Project',
      summary: 'Salesforce Incentive-Program Tracking',
      fields: { 'Anti-Kickback Review': 'Required' },
    });
    expect(preview?.resourceUri).toBe(ISSUE_PREVIEW_URI);
    expect(preview?.structuredContent).toMatchObject({
      kind: 'issue',
      title: 'Create Jira issue',
      subtitle: 'CIO · Project',
      confirmTool: 'jira_create_issue',
      confirmLabel: 'Create',
      editable: { summaryKey: 'summary', descriptionKey: 'description' },
    });
    // The confirm button's args are the call's own, verbatim — nothing
    // resolved or stripped, so a round-trip through the card changes only
    // what the person actually edited.
    expect(preview?.structuredContent.confirmArgs).toEqual({
      projectKey: 'CIO',
      issueType: 'Project',
      summary: 'Salesforce Incentive-Program Tracking',
      fields: { 'Anti-Kickback Review': 'Required' },
    });
    expect(preview?.structuredContent.fields).toEqual([
      { label: 'Anti-Kickback Review', value: 'Required' },
    ]);
    // Every previewId is fresh — no stale "already decided" receipt from a
    // localStorage lookup keyed off a repeated id.
    const again = jiraIssueApprovalPreview('jira_create_issue', { projectKey: 'CIO' });
    expect(preview?.structuredContent.previewId).not.toBe(again?.structuredContent.previewId);
  });

  it('only offers editing the fields an update call is already touching', () => {
    const preview = jiraIssueApprovalPreview('jira_update_issue', {
      issueKey: 'CIO-51',
      summary: 'New summary',
    });
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
});
