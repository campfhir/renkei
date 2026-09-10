/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The onbase_admin_* tools against a scripted Administration API. This
 * connector is fully self-contained — a separate Hyland OAuth client from
 * the onbase_* Document connector (see admin-tools.ts's header) — so every
 * request, including name→id resolution, rides the SAME `auth.api`, never
 * a second auth object. What these pin down:
 *
 *   - names resolve to ids INSIDE the tools, against the Administration
 *     API's OWN /api/{kind} listings;
 *   - onbase_admin_assign_keyword_types READ-MERGE-WRITEs: the PUT replaces
 *     every assignment, so untouched assignments must survive, changed ones
 *     must update, and `remove: true` must drop exactly the named one;
 *   - a missing onbase-admin configuration surfaces as a plain refusal
 *     (from the worker's `not_configured` on every call), not a crash;
 *   - user groups resolve by name wherever a grant is keyed by their id,
 *     a document type created without one is answered with the warning
 *     that nobody can see it, and the document type ↔ user group grant
 *     tools READ-MERGE-WRITE like the keyword assignment one does.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOnbaseAdminTools } from './admin-tools';
import type { OnBaseApiRequest, OnBaseAuth } from './onbase-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
    origin: 'https://renkei.example',
  }) as unknown as MCPToolContext;

const DOCUMENT_TYPES = { items: [{ id: '7', name: 'Invoices' }] };
const DOCUMENT_TYPE_GROUPS = { items: [{ id: '50', name: 'Finance' }] };
const KEYWORD_TYPES = {
  items: [
    { id: '101', name: 'Vendor' },
    { id: '102', name: 'Invoice Amount' },
    { id: '999', name: 'Legacy Field' },
  ],
};
const KEYWORD_TYPE_GROUPS = { items: [{ id: '60', name: 'Invoice Fields' }] };
const FILE_TYPES = { items: [{ id: '80', name: 'PDF Document' }] };
const DISK_GROUPS = { items: [{ id: '10', name: 'System' }] };
const USER_GROUPS = {
  items: [
    { id: '1', name: 'MANAGER' },
    { id: '201', name: 'Clinical Staff' },
    { id: '202', name: 'Finance' },
  ],
};
const USERS = {
  items: [
    { id: '301', name: 'MANAGER', isServiceAccount: false },
    { id: '302', name: 'jdoe', isServiceAccount: false },
    { id: '303', name: 'svc-renkei', isServiceAccount: true },
  ],
};

function adminCatalogDefault(
  request: OnBaseApiRequest
): { status: number; body: unknown } | undefined {
  switch (request.path) {
    case '/api/document-types':
      return { status: 200, body: DOCUMENT_TYPES };
    case '/api/document-type-groups':
      return { status: 200, body: DOCUMENT_TYPE_GROUPS };
    case '/api/keyword-types':
      return { status: 200, body: KEYWORD_TYPES };
    case '/api/keyword-type-groups':
      return { status: 200, body: KEYWORD_TYPE_GROUPS };
    case '/api/file-types':
      return { status: 200, body: FILE_TYPES };
    case '/api/disk-groups':
      return { status: 200, body: DISK_GROUPS };
    case '/api/user-groups':
      return { status: 200, body: USER_GROUPS };
    case '/api/users':
      return { status: 200, body: USERS };
    default:
      return undefined;
  }
}

interface Scripted {
  requests: OnBaseApiRequest[];
  auth: OnBaseAuth;
}

/** An OnBaseAuth whose api() plays scripted routes (falling back to the catalog fixtures above) and records requests. */
function scriptedAuth(
  routes: (request: OnBaseApiRequest) => { status: number; body: unknown } | undefined
): Scripted {
  const requests: OnBaseApiRequest[] = [];
  return {
    requests,
    auth: {
      kind: 'oauth',
      api: (request) => {
        requests.push(request);
        const routed = routes(request) ?? adminCatalogDefault(request);
        if (!routed) return Promise.resolve(`Unscripted route ${request.method} ${request.path}`);
        return Promise.resolve({
          status: routed.status,
          contentType: 'application/json',
          body: JSON.stringify(routed.body),
        });
      },
      content: () => Promise.resolve('no content in this suite'),
      access: () => Promise.resolve({ accessToken: 'at', accountId: 'acct' }),
    },
  };
}

/** As if onbase-admin were never configured: every call, catalog reads included, refuses. */
function deniedAdminAuth(): OnBaseAuth {
  const refusal = 'The OnBase Administration API is not configured for this organization.';
  return {
    kind: 'oauth',
    api: () => Promise.resolve(refusal),
    content: () => Promise.resolve(refusal),
    access: () => Promise.resolve({ accessToken: 'at', accountId: 'acct' }),
  };
}

function tools(auth: OnBaseAuth): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerOnbaseAdminTools(server, context(), auth);
  return registered;
}

describe('onbase_admin_create_document_type', () => {
  it('resolves group, file format and disk group by name and posts the create', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'POST' && request.path === '/api/document-types') {
        return { status: 200, body: { id: '901', name: 'Employee Profile' } };
      }
      return undefined;
    });

    const result = await tools(scripted.auth).get('onbase_admin_create_document_type')!({
      name: 'Employee Profile',
      documentTypeGroup: 'Finance',
      defaultFileFormat: 'PDF Document',
      defaultDiskGroup: 'System',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('id 901');
    // No user group → nobody can see it; the answer must say so and point
    // at the grant tool rather than reporting a clean success.
    expect(result.content[0].text).toContain('No user group has been granted it');
    expect(result.content[0].text).toContain('onbase_admin_assign_document_type_user_groups');

    const created = scripted.requests.find(
      (r) => r.method === 'POST' && r.path === '/api/document-types'
    );
    // The spec types these ids as numbers even though every listing hands
    // them back as strings.
    expect(created?.body).toMatchObject({
      name: 'Employee Profile',
      documentTypeGroupId: 50,
      defaultFileFormatId: 80,
      defaultDiskGroupId: 10,
    });
    expect(created?.body).not.toHaveProperty('userGroupIds');
  });

  it('resolves userGroups by name into integer userGroupIds and reports the grant', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'POST' && request.path === '/api/document-types') {
        return { status: 200, body: { id: '902', name: 'Provider Credentials' } };
      }
      return undefined;
    });

    const result = await tools(scripted.auth).get('onbase_admin_create_document_type')!({
      name: 'Provider Credentials',
      documentTypeGroup: 'Finance',
      defaultFileFormat: 'PDF Document',
      defaultDiskGroup: 'System',
      userGroups: ['Clinical Staff', '1'],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Granted to 2 user group(s)');
    expect(result.content[0].text).toContain('Clinical Staff (id 201)');
    expect(result.content[0].text).toContain('MANAGER (id 1)');
    expect(result.content[0].text).not.toContain('No user group has been granted it');

    const created = scripted.requests.find(
      (r) => r.method === 'POST' && r.path === '/api/document-types'
    );
    expect(created?.body).toMatchObject({ userGroupIds: [201, 1] });
  });

  it('refuses an unknown user group name before posting anything', async () => {
    const scripted = scriptedAuth(() => undefined);
    const result = await tools(scripted.auth).get('onbase_admin_create_document_type')!({
      name: 'X',
      documentTypeGroup: 'Finance',
      defaultFileFormat: 'PDF Document',
      defaultDiskGroup: 'System',
      userGroups: ['Nurses'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No user group is named "Nurses"');
    expect(scripted.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('refuses cleanly with an unknown document type group name', async () => {
    const scripted = scriptedAuth(() => undefined);
    const result = await tools(scripted.auth).get('onbase_admin_create_document_type')!({
      name: 'X',
      documentTypeGroup: 'Nope',
      defaultFileFormat: 'PDF Document',
      defaultDiskGroup: 'System',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No document type group is named "Nope"');
  });

  it('surfaces a missing onbase-admin configuration as a refusal, not a crash', async () => {
    const result = await tools(deniedAdminAuth()).get('onbase_admin_create_document_type')!({
      name: 'X',
      documentTypeGroup: 'Finance',
      defaultFileFormat: 'PDF Document',
      defaultDiskGroup: 'System',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });
});

describe('onbase_admin_update_document_type', () => {
  it('builds a JSON-Patch replace document from flat fields', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'PATCH' && request.path === '/api/document-types/7') {
        return { status: 200, body: { id: '7' } };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_admin_update_document_type')!({
      documentType: 'Invoices',
      fields: { cachingAllowed: true, autoNameString: '%N - %D2' },
    });
    expect(result.isError).toBeUndefined();
    const patched = scripted.requests.find((r) => r.method === 'PATCH');
    expect(patched?.body).toEqual([
      { op: 'replace', path: '/cachingAllowed', value: true },
      { op: 'replace', path: '/autoNameString', value: '%N - %D2' },
    ]);
  });
});

describe('onbase_admin_get_document_type', () => {
  it('returns the full admin record as JSON', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'GET' && request.path === '/api/document-types/7') {
        return { status: 200, body: { id: '7', name: 'Invoices', cachingAllowed: true } };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_admin_get_document_type')!({
      documentType: 'Invoices',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: '7',
      name: 'Invoices',
      cachingAllowed: true,
    });
  });
});

describe('onbase_admin_assign_keyword_types', () => {
  const CURRENT_ASSIGNMENTS = {
    items: [
      {
        keywordTypeId: '101',
        documentTypeId: '7',
        keywordTypeGroupId: '0',
        required: true,
        sequenceNum: 0,
        defaultKeywordValue: 'ACME',
        hidden: false,
      },
      {
        keywordTypeId: '999',
        documentTypeId: '7',
        keywordTypeGroupId: '0',
        required: false,
        sequenceNum: 1,
      },
    ],
  };

  it('read-merge-writes: preserves untouched assignments, changes named ones, and removes on request', async () => {
    let written: unknown;
    const scripted = scriptedAuth((request) => {
      if (
        request.method === 'GET' &&
        request.path === '/api/document-types/keyword-types' &&
        request.query?.documentTypeId === '7'
      ) {
        return { status: 200, body: CURRENT_ASSIGNMENTS };
      }
      if (request.method === 'PUT' && request.path === '/api/document-types/7/keyword-types') {
        written = request.body;
        return { status: 200, body: { items: [] } };
      }
      return undefined;
    });

    const result = await tools(scripted.auth).get('onbase_admin_assign_keyword_types')!({
      documentType: 'Invoices',
      assignments: [
        // Change an existing assignment's default value; required/sequence
        // untouched fields must survive from the current collection.
        { keywordType: 'Vendor', defaultKeywordValue: 'Beta Corp' },
        // Add a new assignment.
        { keywordType: 'Invoice Amount', required: true, sequenceNum: 2 },
        // Remove one that isn't named by id/name anywhere in KEYWORD_TYPES
        // fixture — use id 999 directly (an id always resolves).
        { keywordType: '999', remove: true },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('1 keyword type(s) added');
    expect(result.content[0].text).toContain('1 changed');
    expect(result.content[0].text).toContain('1 removed');

    const items = written as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    const vendor = items.find((i) => i.keywordTypeId === '101');
    expect(vendor).toMatchObject({
      keywordTypeId: '101',
      documentTypeId: '7',
      // Untouched field from the GET must survive the merge.
      required: true,
      defaultKeywordValue: 'Beta Corp',
    });
    const amount = items.find((i) => i.keywordTypeId === '102');
    expect(amount).toMatchObject({
      keywordTypeId: '102',
      documentTypeId: '7',
      required: true,
      sequenceNum: 2,
    });
    expect(items.some((i) => i.keywordTypeId === '999')).toBe(false);
  });
});

describe('user and user group lookup', () => {
  it('lists user groups by name and id, optionally filtered', async () => {
    const scripted = scriptedAuth(() => undefined);
    const all = await tools(scripted.auth).get('onbase_admin_list_user_groups')!({});
    expect(all.content[0].text).toContain('Clinical Staff — id 201');
    expect(all.content[0].text).toContain('MANAGER — id 1');

    const some = await tools(scripted.auth).get('onbase_admin_list_user_groups')!({
      nameContains: 'clinical',
    });
    expect(some.content[0].text).toContain('Clinical Staff — id 201');
    expect(some.content[0].text).not.toContain('Finance');
  });

  it('lists users without service accounts unless asked', async () => {
    const scripted = scriptedAuth(() => undefined);
    const people = await tools(scripted.auth).get('onbase_admin_list_users')!({});
    expect(people.content[0].text).toContain('jdoe — id 302');
    expect(people.content[0].text).not.toContain('svc-renkei');

    const everyone = await tools(scripted.auth).get('onbase_admin_list_users')!({
      includeServiceAccounts: true,
    });
    expect(everyone.content[0].text).toContain('svc-renkei — id 303 [service account]');
    // Listings ask for everything (limit 0), not the server's first page.
    const listed = scripted.requests.find((r) => r.method === 'GET' && r.path === '/api/users');
    expect(listed?.query).toEqual({ limit: '0' });
  });

  it('shows a user group with its members resolved to user names', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'GET' && request.path === '/api/user-groups/201') {
        return { status: 200, body: { id: '201', name: 'Clinical Staff' } };
      }
      if (
        request.method === 'GET' &&
        request.path === '/api/users/user-groups' &&
        request.query?.userGroupId === '201'
      ) {
        return {
          status: 200,
          body: {
            items: [
              { userGroupId: '201', userId: '302' },
              { userGroupId: '201', userId: '999' },
            ],
          },
        };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_admin_get_user_group')!({
      userGroup: 'Clinical Staff',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Members (2)');
    expect(result.content[0].text).toContain('jdoe (id 302)');
    expect(result.content[0].text).toContain('user 999');
  });

  it("shows a user's groups and never echoes a password", async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'GET' && request.path === '/api/users/302') {
        return { status: 200, body: { id: '302', name: 'jdoe', password: 'hunter2' } };
      }
      if (
        request.method === 'GET' &&
        request.path === '/api/users/user-groups' &&
        request.query?.userId === '302'
      ) {
        return { status: 200, body: { items: [{ userGroupId: '201', userId: '302' }] } };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_admin_get_user')!({ user: 'jdoe' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Clinical Staff (id 201)');
    expect(result.content[0].text).not.toContain('hunter2');
  });
});

describe('onbase_admin_list_user_group_access', () => {
  it('names the groups granted a document type, or says nobody can see it', async () => {
    let grants: { userGroupId: string; documentTypeId: string }[] = [];
    const scripted = scriptedAuth((request) => {
      if (
        request.method === 'GET' &&
        request.path === '/api/document-types/user-groups' &&
        request.query?.documentTypeId === '7'
      ) {
        return { status: 200, body: { items: grants } };
      }
      return undefined;
    });
    const tool = tools(scripted.auth).get('onbase_admin_list_user_group_access')!;

    const none = await tool({ documentType: 'Invoices' });
    expect(none.content[0].text).toContain('granted to NO user groups');
    expect(none.content[0].text).toContain('onbase_admin_assign_document_type_user_groups');

    grants = [{ userGroupId: '202', documentTypeId: '7' }];
    const some = await tool({ documentType: 'Invoices' });
    expect(some.content[0].text).toContain('granted to 1 user group(s)');
    expect(some.content[0].text).toContain('Finance (id 202)');
  });

  it('lists what a user group may see from the other side', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.query?.userGroupId !== '202') return undefined;
      if (request.path === '/api/document-types/user-groups') {
        return { status: 200, body: { items: [{ userGroupId: '202', documentTypeId: '7' }] } };
      }
      if (request.path === '/api/document-type-groups/user-groups') {
        return {
          status: 200,
          body: { items: [{ userGroupId: '202', documentTypeGroupId: '50' }] },
        };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_admin_list_user_group_access')!({
      userGroup: 'Finance',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Invoices (id 7)');
    expect(result.content[0].text).toContain('Finance (id 50)');
  });

  it('insists on exactly one side', async () => {
    const scripted = scriptedAuth(() => undefined);
    const result = await tools(scripted.auth).get('onbase_admin_list_user_group_access')!({});
    expect(result.isError).toBe(true);
  });
});

describe('onbase_admin_assign_document_type_user_groups', () => {
  it('read-merge-writes the full grant list, keeping unnamed groups', async () => {
    let written: unknown;
    let writtenQuery: unknown;
    const scripted = scriptedAuth((request) => {
      if (
        request.method === 'GET' &&
        request.path === '/api/document-types/user-groups' &&
        request.query?.documentTypeId === '7'
      ) {
        return {
          status: 200,
          body: {
            items: [
              { userGroupId: '1', documentTypeId: '7' },
              { userGroupId: '202', documentTypeId: '7' },
            ],
          },
        };
      }
      if (request.method === 'PUT' && request.path === '/api/document-types/user-groups') {
        written = request.body;
        writtenQuery = request.query;
        return { status: 200, body: { items: [] } };
      }
      return undefined;
    });

    const result = await tools(scripted.auth).get('onbase_admin_assign_document_type_user_groups')!(
      {
        documentType: 'Invoices',
        userGroups: [{ userGroup: 'Clinical Staff' }, { userGroup: 'Finance', remove: true }],
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('1 user group(s) granted, 1 revoked');
    expect(result.content[0].text).toContain('MANAGER (id 1)');
    expect(result.content[0].text).toContain('Clinical Staff (id 201)');
    expect(writtenQuery).toEqual({ documentTypeId: '7' });
    // MANAGER (unnamed) survives; Finance is gone; Clinical Staff is new.
    expect(written).toEqual([
      { userGroupId: '1', documentTypeId: '7' },
      { userGroupId: '201', documentTypeId: '7' },
    ]);
  });

  it('wraps the document type group grant in the collection object the endpoint takes', async () => {
    let written: unknown;
    const scripted = scriptedAuth((request) => {
      if (
        request.method === 'GET' &&
        request.path === '/api/document-type-groups/user-groups' &&
        request.query?.documentTypeGroupId === '50'
      ) {
        return { status: 200, body: { items: [] } };
      }
      if (request.method === 'PUT' && request.path === '/api/document-type-groups/50/user-groups') {
        written = request.body;
        return { status: 200, body: { items: [] } };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get(
      'onbase_admin_assign_document_type_group_user_groups'
    )!({ documentTypeGroup: 'Finance', userGroups: [{ userGroup: 'Clinical Staff' }] });
    expect(result.isError).toBeUndefined();
    expect(written).toEqual({ items: [{ userGroupId: '201', documentTypeGroupId: '50' }] });
  });
});
