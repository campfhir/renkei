/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * A request type for a service project: how it reads on the review page
 * (what Jira's API cannot set, said up front), what reads back, and what
 * applying sends — on the JSM grant, with the experimental opt-in the
 * create call takes. A request type of the same name appearing since
 * stops it before a second is made.
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
  applyRequestType,
  readRequestTypePayload,
  requestTypeTitle,
  type RequestTypePayload,
} from './request-type';

const jsm: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-jsm',
  auth: authedFetch((url, init) => fetch(url, init), 'atlassian-jsm:acct-jsm'),
  label: 'Jira Service Management',
};
const scope = { subject: 'subject-1' };

function outage(): RequestTypePayload {
  return {
    serviceDesk: { id: '3', projectId: '10100', projectKey: 'HELP', projectName: 'Help desk' },
    operations: [
      {
        op: 'create_request_type',
        name: 'Report an outage',
        description: 'Something is down for everyone',
        helpText: 'Tell us what stopped working and when',
        workType: { id: '10011', name: 'Incident' },
      },
    ],
  };
}

const LISTING =
  '/rest/servicedeskapi/servicedesk/3/requesttype?limit=100&includeHiddenRequestTypesInSearch=true' +
  '&searchQuery=Report%20an%20outage';

let site: Record<string, [number, unknown]>;
let requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[];

beforeEach(() => {
  site = { [LISTING]: [200, { values: [] }] };
  requests = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(FAKE_BASE.length);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      path,
      body,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    if (method === 'POST' && path === '/rest/servicedeskapi/servicedesk/3/requesttype') {
      return new Response(JSON.stringify({ id: '11001', name: body.name }), { status: 200 });
    }
    const [status, answer] = site[path] ?? [404, { errorMessage: 'No such thing.' }];
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
});

describe('describing', () => {
  it('says what it adds, what Jira sets on its own, and which connection applies it', () => {
    const description = describeChange({
      kind: 'request_type',
      payload: outage(),
      siteUrl: 'https://acme.atlassian.net',
    });
    expect(description.operations.map((operation) => operation.text)).toEqual([
      'Add the request type “Report an outage” to HELP, backed by the work type “Incident”',
    ]);
    expect(description.operations[0]?.details).toEqual([
      'Description: Something is down for everyone',
      'Help text: Tell us what stopped working and when',
      'It gets the headset icon and the work type’s fields, and stays hidden on the portal ' +
        'until an admin puts it in a portal group (Project settings → Request types) — Jira’s ' +
        'API sets none of those.',
    ]);
    expect(description.siteWide).toBe(false);
    expect(description.reach).toBe(
      'The service project HELP (Help desk) on https://acme.atlassian.net and its customer ' +
        'portal. A request type is the project’s own. Applying runs on your Jira Service ' +
        'Management connection.'
    );
    expect(description.applyNote).toContain('Jira Service Management connection');
    expect(requestTypeTitle(outage())).toBe('New request type “Report an outage” for HELP');
  });

  it('reads back exactly what it wrote, and nothing else', () => {
    expect(readRequestTypePayload(outage())).toEqual(outage());
    expect(readRequestTypePayload({ ...outage(), operations: [] })).toBeNull();
    expect(
      readRequestTypePayload({
        ...outage(),
        operations: [{ op: 'create_request_type', name: 'No work type' }],
      })
    ).toBeNull();
  });
});

describe('applying', () => {
  it('checks the name is free, then creates it with the experimental opt-in', async () => {
    const outcome = await applyRequestType(scope, jsm, outage());
    expect(outcome.status).toBe('applied');
    expect(outcome.results[0]?.detail).toBe(
      'Created as 11001. Hidden on the portal until it is put in a portal group in Project settings.'
    );
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['GET', LISTING],
      ['POST', '/rest/servicedeskapi/servicedesk/3/requesttype'],
    ]);
    expect(requests[1]?.body).toEqual({
      name: 'Report an outage',
      issueTypeId: '10011',
      description: 'Something is down for everyone',
      helpText: 'Tell us what stopped working and when',
    });
    expect(requests[1]?.headers['X-ExperimentalApi']).toBe('opt-in');
  });

  it('stops before adding a second request type of the name', async () => {
    site[LISTING] = [
      200,
      { values: [{ id: '11000', name: 'report an outage', issueTypeId: '10010' }] },
    ];
    const outcome = await applyRequestType(scope, jsm, outage());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe(
      'A request type named “report an outage” is on HELP now (11000), so another was not added.'
    );
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('passes on Jira Service Management’s own reason for a refusal', async () => {
    site[LISTING] = [403, { errorMessage: 'You need to be an administrator of this project.' }];
    const outcome = await applyRequestType(scope, jsm, outage());
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toContain(
      'You need to be an administrator of this project.'
    );
  });
});
