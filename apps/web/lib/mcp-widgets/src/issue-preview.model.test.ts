/**
 * The work-item card's rules (issue-preview.model.ts): what a Jira or JSM
 * preview shows, what Create (or a host's Cancel) sends, and what each
 * answer leaves on the card. These were the browser suite's
 * (widget-card.spec.ts, widget-card-resolve.spec.ts,
 * jsm-create-request-card.spec.ts); the specs keep one real press through
 * the frame. What the server puts in a preview (a JSM form's rows, labels
 * resolved to ids) is jsm.test.ts's; the chips box's own rules are
 * chips.model.test.ts's.
 */

import type { ToolResult } from './bridge';
import { chipLabel, chipsReducer, initialChips, offeredOptions } from './chips.model';
import type { DoneState } from './ui';
import {
  descriptionValue,
  fieldEditOf,
  fieldValue,
  gatherArgs,
  issueCardOf,
  planPress,
  settle,
  stateKeyOf,
  summaryValue,
  type IssueInputs,
  type IssuePreview,
} from './issue-preview.model';

/** jira_create_issue_preview's structuredContent for the spec's issue (jira/write.ts). */
const CREATE = {
  kind: 'issue',
  previewId: 'p-1',
  title: 'Create Jira issue',
  subtitle: 'OPS · Task',
  confirmTool: 'jira_create_issue_confirm',
  confirmLabel: 'Create',
  confirmArgs: {
    projectKey: 'OPS',
    issueType: 'Task',
    summary: 'Rotate the Zoom webhook secret',
    priority: 'High',
    description: 'The current secret is six months old.',
  },
  editable: { summaryKey: 'summary', descriptionKey: 'description' },
  fields: [
    { label: 'Project', value: 'OPS' },
    { label: 'Type', value: 'Task' },
    { label: 'Priority', value: 'High' },
  ],
};

const awaiting = (structuredContent: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({
  content: [{ type: 'text', text: 'Awaiting the user’s decision on the preview card.' }],
  structuredContent,
  ...extra,
});

const nothingRemembered = () => null;

function live(structuredContent: unknown = CREATE): IssuePreview {
  const card = issueCardOf(awaiting(structuredContent), nothingRemembered);
  if (card.kind !== 'live') throw new Error(`expected a live card, got ${card.kind}`);
  return card.preview;
}

/** The controls exactly as the preview filled them. */
function untouched(preview: IssuePreview): IssueInputs {
  return {
    summary: summaryValue(preview),
    description: descriptionValue(preview),
    fields: preview.rows.flatMap((row) =>
      row.editable ? [{ edit: row.editable, raw: row.editable.value }] : []
    ),
  };
}

const answer = (text: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text }],
  isError,
});

describe('what a preview shows', () => {
  it('a Jira create preview is a live card titled for it, with its project and type, Create and Cancel', () => {
    const preview = live();
    expect(preview).toMatchObject({
      title: 'Create Jira issue',
      subtitle: 'OPS · Task',
      confirmTool: 'jira_create_issue_confirm',
      confirmLabel: 'Create',
      cancelLabel: 'Cancel',
      cancelTool: '',
      stateKey: 'renkei-preview:p-1',
    });
    expect(summaryValue(preview)).toBe('Rotate the Zoom webhook secret');
    expect(descriptionValue(preview)).toBe('The current secret is six months old.');
    // Priority is shown as a plain value: the preview did not mark it editable.
    expect(preview.rows).toEqual([
      { label: 'Project', value: 'OPS' },
      { label: 'Type', value: 'Task' },
      { label: 'Priority', value: 'High' },
    ]);
  });

  it('buttons with no label of their own read Confirm and Cancel', () => {
    const { confirmLabel: _, ...unlabelled } = CREATE;
    expect(live(unlabelled)).toMatchObject({ confirmLabel: 'Confirm', cancelLabel: 'Cancel' });
  });

  it('a card with no editable keys has no Summary or Description box', () => {
    const { editable: _, ...fixed } = CREATE;
    const preview = live(fixed);
    expect(summaryValue(preview)).toBeNull();
    expect(descriptionValue(preview)).toBeNull();
  });

  it('an update shows each row’s current value beside the new one', () => {
    const preview = live({
      ...CREATE,
      title: 'Update OPS-7',
      fields: [
        { label: 'Priority', value: 'High', oldValue: 'Low' },
        { label: 'Labels', value: 'x', oldValue: '' },
      ],
    });
    expect(preview.rows).toEqual([
      { label: 'Priority', value: 'High', oldValue: 'Low' },
      { label: 'Labels', value: 'x' },
    ]);
  });

  it('a failed preview tool is an error card with its words', () => {
    expect(
      issueCardOf(
        awaiting(CREATE, { isError: true, content: [{ type: 'text', text: 'No such project' }] }),
        nothingRemembered
      )
    ).toEqual({ kind: 'error', title: 'Create Jira issue', message: 'No such project' });
  });

  it('a preview with no confirm tool cannot be acted on, and says so', () => {
    expect(issueCardOf({ structuredContent: { kind: 'issue' } }, nothingRemembered)).toEqual({
      kind: 'error',
      title: 'Preview',
      message: 'The preview could not be prepared.',
    });
  });
});

describe('a card already decided', () => {
  const RECEIPT: DoneState = { icon: 'sent', headline: 'Created issue OPS-99.' };

  it('opens on the receipt the server recorded, wherever it is opened', () => {
    expect(issueCardOf(awaiting({ ...CREATE, resolved: RECEIPT }), nothingRemembered)).toEqual({
      kind: 'receipt',
      state: RECEIPT,
    });
  });

  it('a decision the model recorded later flips the card to its receipt on the next result', () => {
    const before = issueCardOf(awaiting(CREATE), nothingRemembered);
    expect(before.kind).toBe('live');
    const resolved = {
      icon: 'sent',
      headline: 'Created by hand in Jira',
      detail: 'OPS-123, filed from the Jira UI',
    };
    expect(issueCardOf(awaiting({ ...CREATE, resolved }), nothingRemembered)).toEqual({
      kind: 'receipt',
      state: resolved,
    });
  });

  it('opens on what this browser remembers under the card’s own key when the server has nothing', () => {
    const asked: string[] = [];
    const card = issueCardOf(awaiting(CREATE), (key) => {
      asked.push(key);
      return { icon: 'cancelled', headline: 'Cancelled' };
    });
    expect(asked).toEqual(['renkei-preview:p-1']);
    expect(card).toEqual({ kind: 'receipt', state: { icon: 'cancelled', headline: 'Cancelled' } });
  });

  it('the server’s receipt wins over this browser’s, which is not even asked', () => {
    const recall = jest.fn(() => ({ icon: 'cancelled' as const, headline: 'Cancelled' }));
    expect(issueCardOf(awaiting({ ...CREATE, resolved: RECEIPT }), recall)).toMatchObject({
      state: RECEIPT,
    });
    expect(recall).not.toHaveBeenCalled();
  });

  it('a receipt in a shape this build does not know is ignored, leaving the live card', () => {
    expect(
      issueCardOf(awaiting({ ...CREATE, resolved: { icon: 'maybe' } }), nothingRemembered).kind
    ).toBe('live');
  });

  it('a preview from an older server, with no id, recalls nothing and reports nothing', () => {
    const { previewId: _, ...older } = CREATE;
    const recall = jest.fn(() => RECEIPT);
    const card = issueCardOf(awaiting(older), recall);
    expect(recall).not.toHaveBeenCalled();
    expect(card).toMatchObject({ kind: 'live', preview: { stateKey: '' } });
    expect(stateKeyOf('')).toBe('');
  });

  it('two previews of the same kind are two cards: one’s receipt never shows on the other', () => {
    expect(stateKeyOf('p-1')).not.toBe(stateKeyOf('p-2'));
  });
});

describe('what Create sends', () => {
  it('the preview’s arguments, as previewed, when nothing was touched', () => {
    const preview = live();
    expect(planPress(preview, 'confirm', untouched(preview))).toEqual({
      kind: 'call',
      name: 'jira_create_issue_confirm',
      args: CREATE.confirmArgs,
    });
  });

  it('an edited summary and description, trimmed', () => {
    const preview = live();
    expect(
      gatherArgs(preview, {
        ...untouched(preview),
        summary: '  Rotate the Webex webhook secret ',
        description: ' Also the Zoom one.\n',
      })
    ).toMatchObject({
      summary: 'Rotate the Webex webhook secret',
      description: 'Also the Zoom one.',
    });
  });

  it('a summary cleared to nothing keeps the previewed one; a cleared description is left out', () => {
    const preview = live();
    const args = gatherArgs(preview, { ...untouched(preview), summary: '  ', description: '' });
    expect(args.summary).toBe('Rotate the Zoom webhook secret');
    expect(args).not.toHaveProperty('description');
  });

  it('never changes the preview’s own arguments', () => {
    const preview = live();
    gatherArgs(preview, { ...untouched(preview), summary: 'Changed', description: '' });
    expect(preview.confirmArgs).toEqual(CREATE.confirmArgs);
  });
});

describe('editable rows', () => {
  const editable = (kind: string, value: unknown, extra: Record<string, unknown> = {}) => ({
    label: 'Field',
    value: 'shown',
    editable: { path: ['fields', 'customfield_1'], kind, value, ...extra },
  });

  it('a row is editable only when the preview names a path and a control it knows', () => {
    expect(fieldEditOf(editable('text', 'a'))).toMatchObject({ kind: 'text', value: 'a' });
    expect(fieldEditOf(editable('slider', 'a'))).toBeUndefined();
    expect(fieldEditOf({ editable: { path: [], kind: 'text' } })).toBeUndefined();
    expect(fieldEditOf({ label: 'Project', value: 'OPS' })).toBeUndefined();
  });

  it('a pick list keeps only options with a value, labelled by their value when unlabelled', () => {
    expect(
      fieldEditOf(
        editable('select', 'high', {
          options: [
            { value: 'high', label: 'High' },
            { value: 'low' },
            { label: 'No value' },
            'junk',
          ],
        })
      )?.options
    ).toEqual([
      { value: 'high', label: 'High' },
      { value: 'low', label: 'low' },
    ]);
  });

  it('checkboxes and chips start from a list of their strings; other controls from a string', () => {
    expect(fieldEditOf(editable('chips', ['a', 2, 'b']))?.value).toEqual(['a', 'b']);
    expect(fieldEditOf(editable('checkboxes', 'a'))?.value).toEqual([]);
    expect(fieldEditOf(editable('number', 3))?.value).toBe('');
  });

  it('each control’s value goes to the confirm tool as it takes it', () => {
    expect(fieldValue('number', ' 5 ')).toBe(5);
    expect(fieldValue('number', '  ')).toBeNull();
    expect(fieldValue('text-array', 'a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(fieldValue('text', '  hi ')).toBe('hi');
    expect(fieldValue('select', ' high ')).toBe(' high ');
    expect(fieldValue('chips', ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('an edited row lands at its path, beside the fields already there, leaving the preview’s alone', () => {
    const confirmArgs = { projectKey: 'OPS', fields: { labels: ['ops'] } };
    const preview = live({
      ...CREATE,
      confirmArgs,
      fields: [
        editable('select', 'high', {
          path: ['fields', 'priority'],
          options: [{ value: 'high' }, { value: 'low' }],
        }),
        editable('number', '3', { path: ['fields', 'story_points'] }),
      ],
    });
    const [priority, points] = preview.rows.map((row) => row.editable!);
    const args = gatherArgs(preview, {
      summary: null,
      description: null,
      fields: [
        { edit: priority!, raw: 'low' },
        { edit: points!, raw: '8' },
      ],
    });
    expect(args).toEqual({
      projectKey: 'OPS',
      fields: { labels: ['ops'], priority: 'low', story_points: 8 },
    });
    expect(confirmArgs).toEqual({ projectKey: 'OPS', fields: { labels: ['ops'] } });
  });
});

describe('Cancel', () => {
  it('in chat calls nothing: the card shows Cancelled and the model is told nothing was written', () => {
    const preview = live();
    expect(planPress(preview, 'cancel', untouched(preview))).toEqual({
      kind: 'local',
      receipt: { icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing was written.' },
      context: 'The user cancelled "Create Jira issue" from the preview card. Nothing was written.',
    });
  });

  it('on a host that sets a cancel tool, sends the edited arguments to it instead', () => {
    const preview = live({ ...CREATE, cancelTool: 'approval_decline', cancelLabel: 'Decline' });
    expect(preview.cancelLabel).toBe('Decline');
    expect(planPress(preview, 'cancel', { ...untouched(preview), summary: 'Edited' })).toEqual({
      kind: 'call',
      name: 'approval_decline',
      args: { ...CREATE.confirmArgs, summary: 'Edited' },
    });
  });

  it('a decline the tool accepted shows its first line, and tells the model the whole answer', () => {
    const preview = live({ ...CREATE, cancelTool: 'approval_decline' });
    expect(settle(preview, 'cancel', answer('Declined.\nThe agent was told.'))).toEqual({
      ok: true,
      receipt: { icon: 'cancelled', headline: 'Declined.', detail: 'OPS · Task' },
      context:
        'The user declined "Create Jira issue" from the preview card. Result: Declined.\nThe agent was told.',
    });
    expect(settle(preview, 'cancel', answer(''))).toMatchObject({
      receipt: { headline: 'Cancelled' },
    });
  });

  it('a decline the tool refused leaves the card live with its words, or a plain line', () => {
    const preview = live({ ...CREATE, cancelTool: 'approval_decline' });
    expect(settle(preview, 'cancel', answer('Already decided', true))).toEqual({
      ok: false,
      error: 'Already decided',
    });
    expect(settle(preview, 'cancel', answer('', true))).toEqual({
      ok: false,
      error: 'The request failed',
    });
  });
});

describe('what Create’s answer leaves on the card', () => {
  it('done: the first line, the subtitle, and the links the tool gave, for opening the new issue', () => {
    const preview = live();
    const text =
      'Created issue OPS-99.\n\n[Open in Jira](https://example.atlassian.net/browse/OPS-99)';
    expect(settle(preview, 'confirm', answer(text))).toEqual({
      ok: true,
      receipt: {
        icon: 'sent',
        headline: 'Created issue OPS-99.',
        detail: 'OPS · Task',
        links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-99' }],
      },
      context: `The user confirmed "Create Jira issue" on the preview card. Result: ${text}`,
    });
  });

  it('a JSM request links both the issue and the customer portal', () => {
    const text =
      'Created request HELP-4.\n[Open in Jira](https://x.atlassian.net/browse/HELP-4) [Customer portal](https://x.atlassian.net/servicedesk/customer/portal/1/HELP-4)';
    const settled = settle(live(), 'confirm', answer(text));
    expect(settled.ok && settled.receipt.links?.map((link) => link.label)).toEqual([
      'Open in Jira',
      'Customer portal',
    ]);
  });

  it('a silent success reads Done, under the title when there is no subtitle', () => {
    const { subtitle: _, ...untitled } = CREATE;
    expect(settle(live(untitled), 'confirm', answer(''))).toMatchObject({
      ok: true,
      receipt: { icon: 'sent', headline: 'Done', detail: 'Create Jira issue' },
    });
  });

  it('a failed write leaves the card live with the tool’s words, or a plain line', () => {
    expect(settle(live(), 'confirm', answer('Field "priority" is invalid', true))).toEqual({
      ok: false,
      error: 'Field "priority" is invalid',
    });
    expect(settle(live(), 'confirm', answer('', true))).toEqual({
      ok: false,
      error: 'The write failed',
    });
  });
});

/**
 * jsm_create_request_preview's structuredContent for the spec's desk
 * (jsm.ts and request-form.ts's formCardRows over e2e/sandbox-stub.mjs's
 * request type 9001): the model asked for the component by NAME, and the
 * server already resolved it to its id.
 */
const JSM = {
  kind: 'issue',
  previewId: 'p-jsm',
  title: 'Create service desk request',
  subtitle: 'Help desk · Report an incident',
  confirmTool: 'jsm_create_request_confirm',
  confirmLabel: 'Create request',
  confirmArgs: {
    serviceDeskId: 'HELP',
    requestTypeId: '9001',
    summary: 'Printer on floor 2 is down',
    components: ['Billing'],
  },
  editable: { summaryKey: 'summary', descriptionKey: 'description' },
  fields: [
    { label: 'Service desk', value: 'Help desk' },
    { label: 'Request type', value: 'Report an incident' },
    {
      label: 'Impact (required)',
      value: 'Choose one',
      editable: {
        path: ['formFields', 'customfield_10010'],
        kind: 'select',
        value: '',
        options: [
          { value: '20001', label: 'Single user' },
          { value: '20002', label: 'Whole site' },
        ],
      },
    },
    {
      label: 'Components',
      value: 'Billing',
      editable: {
        path: ['components'],
        kind: 'chips',
        value: ['10042'],
        options: [
          { value: '10042', label: 'Billing' },
          { value: '10043', label: 'Platform' },
        ],
      },
    },
    {
      label: 'Priority',
      value: '—',
      editable: {
        path: ['priority'],
        kind: 'select',
        value: '',
        options: [
          { value: '2', label: 'High' },
          { value: '3', label: 'Medium' },
        ],
      },
    },
  ],
};

describe('the service desk request card', () => {
  const preview = live(JSM);
  const [impact, components, priority] = preview.rows.flatMap((row) =>
    row.editable ? [row.editable] : []
  );

  it('reads the desk and the request type by name, and labels its button for a request', () => {
    expect(preview).toMatchObject({
      title: 'Create service desk request',
      subtitle: 'Help desk · Report an incident',
      confirmLabel: 'Create request',
    });
    expect(preview.rows.slice(0, 2)).toEqual([
      { label: 'Service desk', value: 'Help desk' },
      { label: 'Request type', value: 'Report an incident' },
    ]);
  });

  it('asks for the required field and priority as pick lists in labels, still unanswered', () => {
    expect(impact).toEqual({
      path: ['formFields', 'customfield_10010'],
      kind: 'select',
      value: '',
      options: [
        { value: '20001', label: 'Single user' },
        { value: '20002', label: 'Whole site' },
      ],
    });
    expect(priority).toMatchObject({ kind: 'select', value: '', path: ['priority'] });
    expect(priority!.options.map((option) => option.label)).toEqual(['High', 'Medium']);
  });

  it('shows components as chips: the one the model named, and only the rest on offer', () => {
    expect(components!.kind).toBe('chips');
    const chips = initialChips(
      components!.options,
      Array.isArray(components!.value) ? components!.value : []
    );
    expect(chips.chosen.map((value) => chipLabel(chips, value))).toEqual(['Billing']);
    expect(offeredOptions(chips).map((option) => option.label)).toEqual(['Platform']);
  });

  it('confirms with the ids behind every label picked', () => {
    let chips = initialChips(
      components!.options,
      Array.isArray(components!.value) ? components!.value : []
    );
    chips = chipsReducer(chips, { type: 'typed', text: 'Platform' });
    expect(offeredOptions(chips)).toEqual([]);

    const plan = planPress(preview, 'confirm', {
      summary: summaryValue(preview),
      description: descriptionValue(preview),
      fields: [
        { edit: impact!, raw: '20002' },
        { edit: components!, raw: [...chips.chosen] },
        { edit: priority!, raw: '2' },
      ],
    });
    expect(plan).toEqual({
      kind: 'call',
      name: 'jsm_create_request_confirm',
      args: {
        serviceDeskId: 'HELP',
        requestTypeId: '9001',
        summary: 'Printer on floor 2 is down',
        components: ['10042', '10043'],
        priority: '2',
        formFields: { customfield_10010: '20002' },
      },
    });
  });

  it('a required pick list left blank goes as blank, for the confirm tool to refuse by name', () => {
    const args = gatherArgs(preview, untouched(preview));
    expect(args.formFields).toEqual({ customfield_10010: '' });
    expect(args.priority).toBe('');
    expect(args.components).toEqual(['10042']);
  });
});
