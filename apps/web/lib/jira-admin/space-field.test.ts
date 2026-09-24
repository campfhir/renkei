/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * A field for a space: how the proposal reads on the review page — shared
 * screens above all — what reads back, and what applying sends to a fake
 * Jira. What must hold: a field of the same name appearing since stops it
 * before a second is made; a context every space shares covers a field
 * with no options of its own; a tab that is gone or a field already on a
 * screen is noticed; a failure stops everything after it.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { describeChange } from './describe';
import { FAKE_BASE } from './fake-site.fixture';
import {
  applySpaceField,
  readSpaceFieldPayload,
  spaceFieldTitle,
  type SpaceFieldPayload,
} from './space-field';

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  authHeader: 'Bearer t',
};
const scope = { tenantId: 'tenant-1', subject: 'subject-1' };

/** A new Vendor select list for OPS, on its create screen and on one HR shows too. */
function newVendor(): SpaceFieldPayload {
  return {
    space: { id: '10000', key: 'OPS' },
    field: { id: null, name: 'Vendor', typeLabel: 'select list (single choice)' },
    operations: [
      { op: 'create_field', name: 'Vendor', description: 'Who supplies it', type: 'select' },
      { op: 'add_context', name: 'Vendor for OPS', issueTypes: [], options: ['Acme', 'Globex'] },
      {
        op: 'add_to_screen',
        screenId: '41',
        screenName: 'OPS: Create',
        tabId: '410',
        tabName: 'Field Tab',
        tabNote: null,
        uses: ['create'],
        sharedWith: [],
        moreShared: false,
      },
      {
        op: 'add_to_screen',
        screenId: '42',
        screenName: 'Shared bug screen',
        tabId: '420',
        tabName: 'Details',
        tabNote: 'It has no “Field Tab” tab, so the field goes on its first tab.',
        uses: ['create', 'edit', 'view'],
        sharedWith: ['HR'],
        moreShared: false,
      },
    ],
  };
}

describe('describing', () => {
  it('says what each step does, and calls out the screen another space shows', () => {
    const description = describeChange({
      kind: 'space_field',
      payload: newVendor(),
      siteUrl: 'https://acme.atlassian.net',
    });
    expect(description.operations.map((operation) => operation.text)).toEqual([
      'Create the custom field “Vendor”, a select list (single choice)',
      'Give “Vendor” a context of its own for OPS, offering “Acme”, “Globex”',
      'Put “Vendor” on the screen “OPS: Create”, tab “Field Tab”',
      'Put “Vendor” on the screen “Shared bug screen”, tab “Details”',
    ]);
    expect(description.operations[0]?.details).toEqual(['Description: Who supplies it']);
    expect(description.operations[3]?.details).toEqual([
      'OPS shows it when creating, editing and viewing an issue',
      'It has no “Field Tab” tab, so the field goes on its first tab.',
      'Also shown by HR — the field appears there too',
    ]);
    expect(description.siteWide).toBe(true);
    expect(description.reach).toBe(
      'The custom field “Vendor” in OPS on https://acme.atlassian.net. Custom fields are ' +
        'site-wide: everyone administering Jira sees it in the field list. Some of the screens ' +
        'it goes on are shown by other spaces too (HR), and the field appears in those spaces ' +
        'as well.'
    );
    expect(spaceFieldTitle(newVendor())).toBe('New field “Vendor” for OPS');
  });

  it('says a context may already cover the space when no options are asked for', () => {
    const payload = newVendor();
    payload.operations[1] = {
      op: 'add_context',
      name: 'Vendor for OPS',
      issueTypes: [{ id: '10002', name: 'Bug' }],
      options: [],
    };
    const described = describeChange({ kind: 'space_field', payload, siteUrl: null });
    expect(described.operations[1]?.text).toBe('Make sure “Vendor” applies in OPS — for Bug only');
  });

  it('reads back only a payload it wrote in full', () => {
    const payload = newVendor();
    expect(readSpaceFieldPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    // An existing field must be named by id.
    expect(
      readSpaceFieldPayload({ ...payload, operations: payload.operations.slice(1) })
    ).toBeNull();
    // A field is created first or not at all.
    expect(
      readSpaceFieldPayload({
        ...payload,
        field: { ...payload.field, id: 'customfield_1' },
        operations: [payload.operations[1], payload.operations[0]],
      })
    ).toBeNull();
    expect(
      readSpaceFieldPayload({
        ...payload,
        operations: [{ ...payload.operations[0], type: 'spreadsheet' }],
      })
    ).toBeNull();
  });
});

describe('applying against Jira', () => {
  let calls: { method: string; path: string; body: unknown }[];
  let site: Record<string, [number, unknown]>;

  beforeEach(() => {
    calls = [];
    site = {
      'GET /rest/api/3/field/search?type=custom&maxResults=50&query=Vendor': [
        200,
        { values: [{ id: 'customfield_10400', name: 'Vendor ID' }] },
      ],
      'POST /rest/api/3/field': [201, { id: 'customfield_10500', name: 'Vendor' }],
      // Jira gave the new field a context for every space.
      'GET /rest/api/3/field/customfield_10500/context?startAt=0&maxResults=100': [
        200,
        { isLast: true, values: [{ id: '20000', name: 'Default', isGlobalContext: true }] },
      ],
      'GET /rest/api/3/field/customfield_10500/context/projectmapping?startAt=0&maxResults=100': [
        200,
        { isLast: true, values: [{ contextId: '20000', isGlobalContext: true }] },
      ],
      'POST /rest/api/3/field/customfield_10500/context': [201, { id: '20001' }],
      'POST /rest/api/3/field/customfield_10500/context/20001/option': [200, { options: [] }],
      'GET /rest/api/3/field/customfield_10500/screens?startAt=0&maxResults=100': [
        200,
        { isLast: true, values: [] },
      ],
      'GET /rest/api/3/screens/41/tabs': [200, [{ id: 410, name: 'Field Tab' }]],
      'GET /rest/api/3/screens/42/tabs': [200, [{ id: 420, name: 'Details' }]],
      'POST /rest/api/3/screens/41/tabs/410/fields': [200, { id: 'customfield_10500' }],
      'POST /rest/api/3/screens/42/tabs/420/fields': [200, { id: 'customfield_10500' }],
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(input).slice(FAKE_BASE.length);
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const [status, body] = site[`${method} ${path}`] ?? [
        404,
        { errorMessages: ['No such thing.'] },
      ];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  });

  const posts = () => calls.filter((call) => call.method === 'POST');

  it('creates the field, gives OPS its own context and options, and puts it on each screen', async () => {
    const outcome = await applySpaceField(scope, access, newVendor());
    expect(outcome.status).toBe('applied');
    expect(outcome.results.map((result) => [result.outcome, result.detail])).toEqual([
      ['done', 'Created as customfield_10500.'],
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
    ]);
    expect(posts().map((call) => [call.path, call.body])).toEqual([
      [
        '/rest/api/3/field',
        {
          name: 'Vendor',
          description: 'Who supplies it',
          type: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
          searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher',
        },
      ],
      [
        '/rest/api/3/field/customfield_10500/context',
        {
          name: 'Vendor for OPS',
          description: 'For OPS, added from Renkei.',
          projectIds: ['10000'],
          issueTypeIds: [],
        },
      ],
      [
        '/rest/api/3/field/customfield_10500/context/20001/option',
        {
          options: [
            { value: 'Acme', disabled: false },
            { value: 'Globex', disabled: false },
          ],
        },
      ],
      ['/rest/api/3/screens/41/tabs/410/fields', { fieldId: 'customfield_10500' }],
      ['/rest/api/3/screens/42/tabs/420/fields', { fieldId: 'customfield_10500' }],
    ]);
  });

  it('makes no second field when one of the name has appeared since', async () => {
    site['GET /rest/api/3/field/search?type=custom&maxResults=50&query=Vendor'] = [
      200,
      { values: [{ id: 'customfield_10499', name: 'vendor' }] },
    ];
    const outcome = await applySpaceField(scope, access, newVendor());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe(
      'A custom field named “vendor” exists now (customfield_10499), so another was not ' +
        'created. Ask for this again to use that one.'
    );
    expect(outcome.results.slice(1).every((result) => result.outcome === 'not_run')).toBe(true);
    expect(posts()).toEqual([]);
  });

  it('lets the context every space shares cover a field with no options of its own', async () => {
    const payload = newVendor();
    payload.operations[1] = {
      op: 'add_context',
      name: 'Vendor for OPS',
      issueTypes: [],
      options: [],
    };
    const outcome = await applySpaceField(scope, access, payload);
    expect(outcome.status).toBe('applied');
    expect(outcome.results[1]?.detail).toBe(
      'Its context for every space covers OPS, so none was added.'
    );
    expect(posts().some((call) => call.path.endsWith('/context'))).toBe(false);
  });

  it('skips a screen the field is on already, and stops at a tab that is gone', async () => {
    const payload: SpaceFieldPayload = {
      ...newVendor(),
      field: { id: 'customfield_10500', name: 'Vendor', typeLabel: 'select list (single choice)' },
      operations: newVendor().operations.slice(2),
    };
    site['GET /rest/api/3/field/customfield_10500/screens?startAt=0&maxResults=100'] = [
      200,
      { isLast: true, values: [{ id: 41, name: 'OPS: Create' }] },
    ];
    site['GET /rest/api/3/screens/42/tabs'] = [200, [{ id: 421, name: 'Other' }]];
    const outcome = await applySpaceField(scope, access, payload);
    expect(outcome.status).toBe('partial');
    expect(outcome.results.map((result) => [result.outcome, result.detail])).toEqual([
      ['done', 'It was on this screen already.'],
      ['failed', 'The tab “Details” is no longer on “Shared bug screen”.'],
    ]);
    expect(posts()).toEqual([]);
  });

  it('stops when OPS has been given a context of its own since', async () => {
    const payload: SpaceFieldPayload = {
      ...newVendor(),
      field: { id: 'customfield_10500', name: 'Vendor', typeLabel: 'select list (single choice)' },
      operations: newVendor().operations.slice(1),
    };
    site['GET /rest/api/3/field/customfield_10500/context?startAt=0&maxResults=100'] = [
      200,
      { isLast: true, values: [{ id: '20002', name: 'Ops vendors', isGlobalContext: false }] },
    ];
    site[
      'GET /rest/api/3/field/customfield_10500/context/projectmapping?startAt=0&maxResults=100'
    ] = [200, { isLast: true, values: [{ contextId: '20002', projectId: '10000' }] }];
    const outcome = await applySpaceField(scope, access, payload);
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe(
      'OPS has a context of its own for this field now (“Ops vendors”), so another was not ' +
        'added. Ask for this again to work with that one.'
    );
    expect(outcome.results.slice(1).map((result) => result.outcome)).toEqual([
      'not_run',
      'not_run',
    ]);
  });
});
