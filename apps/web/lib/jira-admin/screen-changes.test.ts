/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Changes to a screen: how they read on the review page — the spaces that
 * show the screen above all — what reads back, and what applying sends to
 * a fake Jira. What must hold: the tabs and fields are read again first;
 * a field already on the screen is not added twice, nor one no longer on
 * its tab taken off; a tab that is gone stops its operation and everything
 * after; taking a field off is a DELETE on the tab, never on the field.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import { authedFetch } from '@renkei/delegate-client';
import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { describeChange } from './describe';
import { FAKE_BASE } from './fake-site.fixture';
import {
  applyScreenChanges,
  readScreenChangesPayload,
  screenChangesTitle,
  type ScreenChangesPayload,
} from './screen-changes';

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
};
const scope = { subject: 'subject-1' };

/** Five changes to the shared bug screen: a field on, one off, one moved, a tab, a rename. */
function changes(): ScreenChangesPayload {
  return {
    screen: { id: '42', name: 'Shared bug screen' },
    spaces: ['HR', 'OPS'],
    moreSpaces: false,
    operations: [
      {
        op: 'add_field',
        fieldId: 'priority',
        fieldName: 'Priority',
        tabId: '420',
        tabName: 'Details',
      },
      {
        op: 'remove_field',
        fieldId: 'customfield_10001',
        fieldName: 'Vendor',
        tabId: '420',
        tabName: 'Details',
      },
      {
        op: 'move_field',
        fieldId: 'summary',
        fieldName: 'Summary',
        tabId: '420',
        tabName: 'Details',
        position: 'last',
      },
      { op: 'add_tab', name: 'More' },
      { op: 'rename_tab', tabId: '420', from: 'Details', to: 'Main' },
      { op: 'rename_screen', from: 'Shared bug screen', to: 'Bug screen' },
    ],
  };
}

function screenSite(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/screens/42/tabs': [200, [{ id: 420, name: 'Details' }]],
    '/rest/api/3/screens/42/tabs/420/fields': [
      200,
      [
        { id: 'summary', name: 'Summary' },
        { id: 'customfield_10001', name: 'Vendor' },
      ],
    ],
    '/rest/api/3/screens/42/tabs/420/fields/customfield_10001': [204, null],
    '/rest/api/3/screens/42/tabs/420/fields/summary/move': [204, null],
    '/rest/api/3/screens/42/tabs/420': [200, { id: 420, name: 'Main' }],
    '/rest/api/3/screens/42': [200, { id: 42, name: 'Bug screen' }],
  };
}

let site: Record<string, [number, unknown]>;
let requests: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  site = screenSite();
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    if (method === 'POST' && path === '/rest/api/3/screens/42/tabs/420/fields') {
      return new Response(JSON.stringify({ id: body.fieldId, name: body.fieldId }), {
        status: 200,
      });
    }
    if (method === 'POST' && path === '/rest/api/3/screens/42/tabs') {
      return new Response(JSON.stringify({ id: 421, name: body.name }), { status: 200 });
    }
    const [status, answer] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    // A 204 may carry no body at all, not even an empty one.
    return new Response(answer === null ? null : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
});

describe('describing', () => {
  it('says what each step does, and names every space that shows the screen', () => {
    const description = describeChange({
      kind: 'screen_changes',
      payload: changes(),
      siteUrl: 'https://acme.atlassian.net',
    });
    expect(description.operations.map((operation) => operation.text)).toEqual([
      'Put “Priority” on “Shared bug screen”, tab “Details”',
      'Take “Vendor” off “Shared bug screen”, tab “Details”',
      'Move “Summary” to the bottom of tab “Details” of “Shared bug screen”',
      'Add a tab “More” to “Shared bug screen”',
      'Rename the tab “Details” of “Shared bug screen” to “Main”',
      'Rename the screen “Shared bug screen” to “Bug screen”',
    ]);
    expect(description.operations[1]?.details).toEqual([
      'The field and its values on every issue stay; it is no longer shown here.',
    ]);
    expect(description.siteWide).toBe(true);
    expect(description.reach).toBe(
      'The screen “Shared bug screen” on https://acme.atlassian.net. HR and OPS show it, and ' +
        'every one of them sees these changes.'
    );
    expect(screenChangesTitle(changes())).toBe('6 changes to the screen “Shared bug screen”');
  });

  it('is quiet about a screen one space alone shows', () => {
    const payload = { ...changes(), spaces: ['OPS'] };
    const description = describeChange({ kind: 'screen_changes', payload, siteUrl: null });
    expect(description.siteWide).toBe(false);
    expect(description.reach).toBe('The screen “Shared bug screen”. Only OPS shows it.');
  });

  it('reads back exactly what it wrote, and nothing else', () => {
    expect(readScreenChangesPayload(changes())).toEqual(changes());
    expect(readScreenChangesPayload({ ...changes(), operations: [] })).toBeNull();
    expect(
      readScreenChangesPayload({
        ...changes(),
        operations: [{ op: 'move_field', fieldId: 'summary', tabId: '420', position: 'sideways' }],
      })
    ).toBeNull();
  });
});

describe('applying', () => {
  it('reads the tabs first, then sends each change in order', async () => {
    const outcome = await applyScreenChanges(scope, access, changes());
    expect(outcome.status).toBe('applied');
    expect(outcome.results.map((result) => result.outcome)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', '/rest/api/3/screens/42/tabs'],
      ['GET', '/rest/api/3/screens/42/tabs/420/fields'],
      ['POST', '/rest/api/3/screens/42/tabs/420/fields'],
      ['DELETE', '/rest/api/3/screens/42/tabs/420/fields/customfield_10001'],
      ['POST', '/rest/api/3/screens/42/tabs/420/fields/summary/move'],
      ['POST', '/rest/api/3/screens/42/tabs'],
      ['PUT', '/rest/api/3/screens/42/tabs/420'],
      ['PUT', '/rest/api/3/screens/42'],
    ]);
    expect(requests[2]?.body).toEqual({ fieldId: 'priority' });
    expect(requests[4]?.body).toEqual({ position: 'Last' });
    expect(requests[5]?.body).toEqual({ name: 'More' });
    expect(requests[6]?.body).toEqual({ name: 'Main' });
    expect(requests[7]?.body).toEqual({ name: 'Bug screen' });
  });

  it('does not add a field that is on the screen now, nor take off one that is gone', async () => {
    site['/rest/api/3/screens/42/tabs/420/fields'] = [
      200,
      [
        { id: 'summary', name: 'Summary' },
        { id: 'priority', name: 'Priority' },
      ],
    ];
    const outcome = await applyScreenChanges(scope, access, changes());
    expect(outcome.status).toBe('applied');
    expect(outcome.results[0]?.detail).toBe('It was on this tab already.');
    expect(outcome.results[1]?.detail).toBe('It was not on this tab any more.');
    // Only the move and the new tab go out; nothing is added or taken off.
    expect(
      requests
        .filter((request) => request.method === 'POST' || request.method === 'DELETE')
        .map((request) => request.path)
    ).toEqual([
      '/rest/api/3/screens/42/tabs/420/fields/summary/move',
      '/rest/api/3/screens/42/tabs',
    ]);
  });

  it('stops at a tab that is gone, running nothing after', async () => {
    site['/rest/api/3/screens/42/tabs'] = [200, [{ id: 499, name: 'Other' }]];
    site['/rest/api/3/screens/42/tabs/499/fields'] = [200, []];
    const outcome = await applyScreenChanges(scope, access, changes());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe('The tab “Details” is no longer on the screen.');
    expect(outcome.results.slice(1).every((result) => result.outcome === 'not_run')).toBe(true);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('stops at the first refusal, leaving the rest not run', async () => {
    site['/rest/api/3/screens/42/tabs/420/fields/customfield_10001'] = [
      400,
      { errorMessages: ['The field cannot be removed from the screen.'] },
    ];
    const outcome = await applyScreenChanges(scope, access, changes());
    expect(outcome.status).toBe('partial');
    expect(outcome.results.map((result) => result.outcome)).toEqual([
      'done',
      'failed',
      'not_run',
      'not_run',
      'not_run',
      'not_run',
    ]);
    expect(outcome.results[1]?.detail).toContain('The field cannot be removed from the screen.');
  });
});
