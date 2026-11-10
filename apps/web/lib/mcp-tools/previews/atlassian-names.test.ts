/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { nameKey } from './card';
import { CONFLUENCE_PREVIEWS } from './confluence';
import { JSM_PREVIEWS } from './jsm';

const card = (table: Record<string, (a: never, n: never) => unknown>, tool: string) => {
  const build = table[tool] as (a: Record<string, unknown>, n: Record<string, string>) => unknown;
  return (args: Record<string, unknown>, names: Record<string, string> = {}) =>
    JSON.stringify(build(args, names));
};
const confluence = (tool: string) => card(CONFLUENCE_PREVIEWS, tool);
const jsm = (tool: string) => card(JSM_PREVIEWS, tool);

const ID = '98765432';
const ACCOUNT = '5b10a2844c20165700ede21g';

describe('Confluence cards show names, never ids', () => {
  const cases: [string, Record<string, unknown>, Record<string, string>][] = [
    ['confluence_update_page', { pageId: ID, markdown: 'x' }, { [nameKey('page', ID)]: 'Runbook' }],
    [
      'confluence_update_blogpost',
      { blogpostId: ID, markdown: 'x' },
      { [nameKey('blogpost', ID)]: 'Launch notes' },
    ],
    [
      'confluence_update_page_title',
      { pageId: ID, title: 'New' },
      { [nameKey('page', ID)]: 'Runbook' },
    ],
    [
      'confluence_move_page',
      { pageId: ID, newParentId: '5551212' },
      { [nameKey('page', ID)]: 'Runbook', [nameKey('page', '5551212')]: 'Home' },
    ],
    ['confluence_delete_page', { pageId: ID }, { [nameKey('page', ID)]: 'Runbook' }],
    ['confluence_delete_blogpost', { blogpostId: ID }, { [nameKey('blogpost', ID)]: 'Post' }],
    ['confluence_delete_database', { databaseId: ID }, { [nameKey('database', ID)]: 'DB' }],
    ['confluence_delete_whiteboard', { whiteboardId: ID }, { [nameKey('whiteboard', ID)]: 'WB' }],
    [
      'confluence_set_page_status',
      { pageId: ID, status: 'archived' },
      { [nameKey('page', ID)]: 'Runbook' },
    ],
    [
      'confluence_update_task_status',
      { taskId: ID, status: 'complete' },
      { [nameKey('task', ID)]: 'Runbook' },
    ],
    [
      'confluence_set_page_property',
      { pageId: ID, key: 'k', value: 'v' },
      { [nameKey('page', ID)]: 'Runbook' },
    ],
    [
      'confluence_add_label',
      { contentId: ID, label: 'ops' },
      { [nameKey('content', ID)]: 'Runbook' },
    ],
    [
      'confluence_add_comment',
      { contentId: ID, contentType: 'page', markdown: 'hi' },
      { [nameKey('page', ID)]: 'Runbook' },
    ],
    [
      'confluence_update_comment',
      { commentId: ID, markdown: 'hi' },
      { [nameKey('comment', ID)]: '“Looks good”' },
    ],
    ['confluence_delete_comment', { commentId: ID }, { [nameKey('comment', ID)]: '“Looks good”' }],
    [
      'confluence_delete_attachment',
      { attachmentId: ID },
      { [nameKey('attachment', ID)]: 'diagram.png' },
    ],
    [
      'confluence_create_page',
      { spaceId: ID, parentId: '5551212', title: 'T' },
      { [nameKey('space', ID)]: 'Engineering', [nameKey('page', '5551212')]: 'Home' },
    ],
  ];

  it.each(cases)('%s: a found name is shown', (tool, args, names) => {
    const shown = confluence(tool)(args, names);
    const first = Object.values(names)[0] ?? '';
    expect(shown).toContain(first.replace(/[“”]/g, '').slice(0, 5));
  });

  it.each(cases)('%s: never prints the id, with or without names', (tool, args, names) => {
    for (const given of [names, {}]) {
      const shown = JSON.stringify(JSON.parse(confluence(tool)(args, given)), (key, value) =>
        key === 'commentId' ? undefined : value
      );
      for (const id of [ID, '5551212']) expect(shown).not.toContain(id);
    }
  });

  it('says "the page" when it cannot be named', () => {
    expect(confluence('confluence_delete_page')({ pageId: ID })).toContain('Delete the page');
  });
});

describe('JSM cards show names, never ids', () => {
  const alertNames = { [nameKey('alert', ID)]: 'CPU high' };
  const cases: [string, Record<string, unknown>, Record<string, string>][] = [
    ['jsm_ops_acknowledge_alert', { alertId: ID }, alertNames],
    ['jsm_ops_close_alert', { alertId: ID }, alertNames],
    [
      'jsm_add_request_participant',
      { issueKey: 'SUP-1', accountId: ACCOUNT },
      { [nameKey('user', ACCOUNT)]: 'Ann Lee' },
    ],
    [
      'jsm_remove_request_participant',
      { issueKey: 'SUP-1', accountId: ACCOUNT },
      { [nameKey('user', ACCOUNT)]: 'Ann Lee' },
    ],
    [
      'jsm_add_customer_to_servicedesk',
      { serviceDeskId: ID, user: ACCOUNT },
      { [nameKey('desk', ID)]: 'IT Help', [nameKey('user', ACCOUNT)]: 'Ann Lee' },
    ],
    [
      'jsm_remove_customer_from_servicedesk',
      { serviceDeskId: ID, user: ACCOUNT },
      { [nameKey('desk', ID)]: 'IT Help', [nameKey('user', ACCOUNT)]: 'Ann Lee' },
    ],
    [
      'jsm_invite_customers_to_servicedesk',
      { serviceDeskId: ID, emails: ['a@b.co'] },
      { [nameKey('desk', ID)]: 'IT Help' },
    ],
    [
      'jsm_ops_create_override',
      {
        scheduleId: ID,
        responderAccountId: ACCOUNT,
        rotationIds: ['7654321'],
        startDate: 'a',
        endDate: 'b',
      },
      {
        [nameKey('schedule', ID)]: 'Primary',
        [nameKey('user', ACCOUNT)]: 'Ann Lee',
        [nameKey('rotation', '7654321')]: 'Weekdays',
      },
    ],
    [
      'jsm_ops_delete_override',
      { scheduleId: ID, alias: 'ov-8675309' },
      { [nameKey('schedule', ID)]: 'Primary', [nameKey('override', 'ov-8675309')]: 'Ann Lee' },
    ],
    [
      'jsm_ops_update_rotation',
      { scheduleId: ID, rotationId: '7654321', participantAccountIds: [ACCOUNT] },
      {
        [nameKey('schedule', ID)]: 'Primary',
        [nameKey('rotation', '7654321')]: 'Weekdays',
        [nameKey('user', ACCOUNT)]: 'Ann Lee',
      },
    ],
    [
      'jsm_ops_create_maintenance',
      { integrationIds: ['int-4455'], policyIds: ['pol-9911'], description: 'Deploy' },
      { [nameKey('integration', 'int-4455')]: 'Datadog' },
    ],
    [
      'jsm_ops_cancel_maintenance',
      { maintenanceId: ID },
      { [nameKey('maintenance', ID)]: 'Deploy window' },
    ],
  ];
  const ids = [ID, ACCOUNT, '7654321', 'ov-8675309', 'int-4455', 'pol-9911'];

  it.each(cases)('%s: a found name is shown', (tool, args, names) => {
    const shown = jsm(tool)(args, names);
    expect(shown).toContain(Object.values(names)[0]);
  });

  it.each(cases)('%s: never prints the id, with or without names', (tool, args, names) => {
    for (const given of [names, {}]) {
      const shown = jsm(tool)(args, given);
      for (const id of ids) expect(shown).not.toContain(id);
    }
  });

  it('keeps an email, which a person already reads', () => {
    expect(
      jsm('jsm_add_customer_to_servicedesk')({ serviceDeskId: ID, user: 'ann@example.com' })
    ).toContain('ann@example.com');
  });

  it('says "the alert" when it cannot be named', () => {
    expect(jsm('jsm_ops_close_alert')({ alertId: ID })).toContain('Close the alert');
  });
});
