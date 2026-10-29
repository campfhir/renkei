/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * A work type for a space: how the proposal reads on the review page — a
 * shared scheme above all — what reads back, and what applying sends to a
 * fake Jira. What must hold: a work type of the same name appearing since
 * stops it before a second is made; a space that moved to another scheme
 * stops the mapping; a type already in a scheme or on a workflow is
 * noticed, not sent twice; the workflow scheme update carries the version
 * and every existing mapping; a failure stops everything after it.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import { authedFetch } from '@renkei/delegate-client';
import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { describeChange } from './describe';
import { FAKE_BASE } from './fake-site.fixture';
import {
  applyWorkType,
  findWorkTypeIcon,
  readWorkTypePayload,
  workTypeTitle,
  type WorkTypePayload,
} from './work-type';

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  auth: authedFetch((url, init) => fetch(url, init), 'atlassian-admin:acct-1'),
};
const scope = { subject: 'subject-1' };

/** A new Incident type for OPS with the bug icon, on Bug's screens and workflow. */
function newIncident(): WorkTypePayload {
  return {
    space: { id: '10000', key: 'OPS', serviceDesk: false },
    workType: { id: null, name: 'Incident', subtask: false },
    operations: [
      {
        op: 'create_work_type',
        name: 'Incident',
        description: 'Something is down',
        subtask: false,
      },
      { op: 'set_icon', avatarId: '10303', iconName: 'bug' },
      {
        op: 'add_to_scheme',
        schemeId: '11',
        schemeName: 'OPS work types',
        sharedWith: ['HR'],
        moreShared: false,
      },
      {
        op: 'map_screens',
        schemeId: '12',
        schemeName: 'OPS screens',
        screenSchemeId: '31',
        screenSchemeName: 'Bug screen scheme',
        likeName: 'Bug',
      },
      {
        op: 'map_workflow',
        schemeId: '13',
        schemeName: 'OPS workflows',
        workflowId: 'wf-bug',
        workflowName: 'Bug workflow',
        likeName: 'Bug',
      },
    ],
  };
}

/** OPS's schemes as applying reads them, with no Incident anywhere yet. */
function opsSchemes(): Record<string, [number, unknown]> {
  return {
    '/rest/api/3/issuetype': [
      200,
      [
        { id: '10001', name: 'Task', subtask: false },
        { id: '10002', name: 'Bug', subtask: false },
        // A team-managed space's own type, which does not count as site-wide.
        { id: '20001', name: 'Incident', scope: { type: 'PROJECT', project: { id: '999' } } },
      ],
    ],
    '/rest/api/3/issuetypescheme/project?projectId=10000': [
      200,
      {
        values: [{ issueTypeScheme: { id: '11', name: 'OPS work types' }, projectIds: ['10000'] }],
      },
    ],
    '/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=11&startAt=0&maxResults=100': [
      200,
      { isLast: true, values: [{ issueTypeId: '10001' }, { issueTypeId: '10002' }] },
    ],
    '/rest/api/3/issuetypescreenscheme/project?projectId=10000': [
      200,
      {
        values: [
          { issueTypeScreenScheme: { id: '12', name: 'OPS screens' }, projectIds: ['10000'] },
        ],
      },
    ],
    '/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=12&startAt=0&maxResults=100':
      [
        200,
        {
          isLast: true,
          values: [
            { issueTypeId: '10002', screenSchemeId: '31' },
            { issueTypeId: 'default', screenSchemeId: '30' },
          ],
        },
      ],
    '/rest/api/3/workflowscheme/project?projectId=10000': [
      200,
      { values: [{ workflowScheme: { id: '13', name: 'OPS workflows' }, projectIds: ['10000'] }] },
    ],
    '/rest/api/3/workflowscheme/read': [
      200,
      [
        {
          id: '13',
          name: 'OPS workflows',
          version: { id: 'v-1', versionNumber: 3 },
          defaultWorkflow: { id: 'wf-simple', name: 'Simple workflow' },
          workflowsForIssueTypes: [
            { workflow: { id: 'wf-bug', name: 'Bug workflow' }, issueTypeIds: ['10002'] },
          ],
        },
      ],
    ],
    '/rest/api/3/issuetype/10050': [200, {}],
    '/rest/api/3/issuetypescheme/11/issuetype': [204, null],
    '/rest/api/3/issuetypescreenscheme/12/mapping': [204, null],
    '/rest/api/3/workflowscheme/update': [200, {}],
  };
}

let site: Record<string, [number, unknown]>;
let requests: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  site = opsSchemes();
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    if (method === 'POST' && path === '/rest/api/3/issuetype') {
      return new Response(JSON.stringify({ id: '10050', name: body.name }), { status: 201 });
    }
    const [status, answer] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    // A 204 may carry no body at all, not even an empty one.
    return new Response(answer === null ? null : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
});

describe('describing', () => {
  it('says what each step does, and calls out the scheme another space shares', () => {
    const description = describeChange({
      kind: 'work_type',
      payload: newIncident(),
      siteUrl: 'https://acme.atlassian.net',
    });
    expect(description.operations.map((operation) => operation.text)).toEqual([
      'Create the work type “Incident”',
      'Give “Incident” the “bug” icon',
      'Add “Incident” to OPS’s work type scheme “OPS work types”',
      'Show “Incident” on the screens “Bug” uses in OPS (screen scheme “Bug screen scheme”)',
      'Run “Incident” on the workflow “Bug workflow” in OPS',
    ]);
    expect(description.operations[0]?.details[0]).toBe('Description: Something is down');
    expect(description.operations[2]?.details).toEqual([
      'Also used by HR — the work type appears there too',
    ]);
    expect(description.operations[4]?.details).toEqual([
      'In OPS’s workflow scheme “OPS workflows”, as “Bug” does.',
    ]);
    expect(description.siteWide).toBe(true);
    expect(description.reach).toBe(
      'The work type “Incident” in OPS on https://acme.atlassian.net. Work types are ' +
        'site-wide: everyone administering Jira sees it in the work type list. OPS’s work type ' +
        'scheme is shared with HR, and the work type appears in those spaces as well.'
    );
    expect(workTypeTitle(newIncident())).toBe('New work type “Incident” for OPS');
  });

  it('warns about an existing type’s icon, which changes everywhere it is used', () => {
    const payload: WorkTypePayload = {
      space: { id: '10000', key: 'OPS', serviceDesk: false },
      workType: { id: '10002', name: 'Bug', subtask: false },
      operations: [{ op: 'set_icon', avatarId: '10303', iconName: 'bug' }],
    };
    const description = describeChange({ kind: 'work_type', payload, siteUrl: null });
    expect(description.operations[0]?.details).toEqual([
      '“Bug” exists already, so its icon changes in every space that uses it.',
    ]);
    expect(description.siteWide).toBe(true);
    expect(description.reach).toContain('Its new icon shows in every space that uses it.');
    expect(workTypeTitle(payload)).toBe('“Bug” for OPS');
  });

  it('reads back exactly what it wrote, and nothing else', () => {
    expect(readWorkTypePayload(newIncident())).toEqual(newIncident());
    expect(readWorkTypePayload({ ...newIncident(), operations: [] })).toBeNull();
    // An existing type is named by id, or the first operation creates it.
    expect(
      readWorkTypePayload({ ...newIncident(), operations: newIncident().operations.slice(1) })
    ).toBeNull();
    expect(
      readWorkTypePayload({
        ...newIncident(),
        operations: [...newIncident().operations, { op: 'drop_everything' }],
      })
    ).toBeNull();
  });

  it('names icons by their file, without the number and extension', () => {
    const icons = [
      { id: '10303', name: 'bug', url: '' },
      { id: '10315', name: 'story', url: '' },
      { id: '10316', name: 'subtask', url: '' },
    ];
    expect(findWorkTypeIcon(icons, 'Bug')?.id).toBe('10303');
    expect(findWorkTypeIcon(icons, '10315')?.name).toBe('story');
    expect(findWorkTypeIcon(icons, 'sub')?.name).toBe('subtask');
    // Two icons match a fragment: nothing is guessed.
    expect(findWorkTypeIcon(icons, 'b')).toBeNull();
    expect(findWorkTypeIcon(icons, 'rocket')).toBeNull();
  });
});

describe('applying', () => {
  it('creates the type, sets its icon, and maps it in each scheme, keeping the rest', async () => {
    const outcome = await applyWorkType(scope, access, newIncident());
    expect(outcome.status).toBe('applied');
    expect(outcome.results.map((result) => result.outcome)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(outcome.results[0]?.detail).toBe('Created as 10050.');
    const writes = requests.filter((request) => request.method !== 'GET');
    expect(writes.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/rest/api/3/issuetype'],
      ['PUT', '/rest/api/3/issuetype/10050'],
      ['PUT', '/rest/api/3/issuetypescheme/11/issuetype'],
      ['PUT', '/rest/api/3/issuetypescreenscheme/12/mapping'],
      ['POST', '/rest/api/3/workflowscheme/read'],
      ['POST', '/rest/api/3/workflowscheme/update'],
    ]);
    expect(writes[0]?.body).toEqual({
      name: 'Incident',
      description: 'Something is down',
      hierarchyLevel: 0,
    });
    expect(writes[1]?.body).toEqual({ avatarId: 10303 });
    expect(writes[2]?.body).toEqual({ issueTypeIds: ['10050'] });
    expect(writes[3]?.body).toEqual({
      issueTypeMappings: [{ issueTypeId: '10050', screenSchemeId: '31' }],
    });
    // The whole scheme goes back: its version, its default, Bug's mapping and the new one.
    expect(writes[5]?.body).toEqual({
      id: '13',
      version: { id: 'v-1', versionNumber: 3 },
      defaultWorkflowId: 'wf-simple',
      workflowsForIssueTypes: [{ workflowId: 'wf-bug', issueTypeIds: ['10002', '10050'] }],
    });
  });

  it('stops before creating a second type of the name, running nothing after', async () => {
    site['/rest/api/3/issuetype'] = [
      200,
      [
        { id: '10001', name: 'Task' },
        { id: '10060', name: 'incident' },
      ],
    ];
    const outcome = await applyWorkType(scope, access, newIncident());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe(
      'A work type named “incident” exists now (10060), so another was not created. Ask for ' +
        'this again to use that one.'
    );
    expect(outcome.results.slice(1).map((result) => result.outcome)).toEqual([
      'not_run',
      'not_run',
      'not_run',
      'not_run',
    ]);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('notices a type already in the scheme, and a space that moved to another scheme', async () => {
    const payload = newIncident();
    payload.workType = { id: '10002', name: 'Bug', subtask: false };
    payload.operations = [
      payload.operations[2] as WorkTypePayload['operations'][number],
      payload.operations[3] as WorkTypePayload['operations'][number],
    ];
    site['/rest/api/3/issuetypescreenscheme/project?projectId=10000'] = [
      200,
      { values: [{ issueTypeScreenScheme: { id: '99', name: 'Other screens' } }] },
    ];
    const outcome = await applyWorkType(scope, access, payload);
    expect(outcome.status).toBe('partial');
    expect(outcome.results[0]).toEqual({
      label: 'Add “Bug” to OPS’s work type scheme “OPS work types”',
      outcome: 'done',
      detail: 'It was in the scheme already.',
    });
    expect(outcome.results[1]?.outcome).toBe('failed');
    expect(outcome.results[1]?.detail).toContain(
      'OPS runs on a different screens scheme now (“Other screens”)'
    );
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('leaves a type that runs on the scheme’s default workflow unmapped, and one mapped elsewhere alone', async () => {
    const payload = newIncident();
    payload.workType = { id: '10001', name: 'Task', subtask: false };
    const toDefault = {
      ...(payload.operations[4] as Extract<
        WorkTypePayload['operations'][number],
        { op: 'map_workflow' }
      >),
      workflowId: 'wf-simple',
      workflowName: 'Simple workflow',
    };
    payload.operations = [toDefault];
    let outcome = await applyWorkType(scope, access, payload);
    expect(outcome.results[0]?.detail).toBe(
      'That is the scheme’s default workflow, which it runs on already.'
    );
    expect(requests.some((request) => request.path === '/rest/api/3/workflowscheme/update')).toBe(
      false
    );

    payload.workType = { id: '10002', name: 'Bug', subtask: false };
    outcome = await applyWorkType(scope, access, payload);
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe(
      'The scheme runs the work type on “Bug workflow” now, so it was left as is.'
    );
  });

  it('stops at the first refusal, leaving the rest not run', async () => {
    site['/rest/api/3/issuetypescheme/11/issuetype'] = [
      403,
      { errorMessages: ['Only Jira administrators can change schemes.'] },
    ];
    const outcome = await applyWorkType(scope, access, newIncident());
    expect(outcome.status).toBe('partial');
    expect(outcome.results.map((result) => result.outcome)).toEqual([
      'done',
      'done',
      'failed',
      'not_run',
      'not_run',
    ]);
    expect(outcome.results[2]?.detail).toContain('Only Jira administrators can change schemes.');
  });
});
