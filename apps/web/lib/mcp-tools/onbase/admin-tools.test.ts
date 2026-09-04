/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The onbase_admin_* tools against a scripted Document API + Administration
 * API. What these pin down:
 *
 *   - names resolve to ids INSIDE the tools, and Document-API-listed
 *     vocabulary (document types, keyword types, groups, file types)
 *     resolves without ever calling the Administration API;
 *   - onbase_admin_assign_keyword_types READ-MERGE-WRITEs: the PUT replaces
 *     every assignment, so untouched assignments must survive, changed ones
 *     must update, and `remove: true` must drop exactly the named one;
 *   - a missing Administration API configuration surfaces as a plain
 *     refusal, not a crash.
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

interface Scripted {
  apiRequests: OnBaseApiRequest[];
  adminRequests: OnBaseApiRequest[];
  auth: OnBaseAuth;
}

function documentApiDefault(request: OnBaseApiRequest): { status: number; body: unknown } | undefined {
  switch (request.path) {
    case '/document-types':
      return { status: 200, body: DOCUMENT_TYPES };
    case '/document-type-groups':
      return { status: 200, body: DOCUMENT_TYPE_GROUPS };
    case '/keyword-types':
      return { status: 200, body: KEYWORD_TYPES };
    case '/keyword-type-groups':
      return { status: 200, body: KEYWORD_TYPE_GROUPS };
    case '/file-types':
      return { status: 200, body: FILE_TYPES };
    default:
      return undefined;
  }
}

/** An OnBaseAuth whose api()/adminApi() play scripted routes and record requests. */
function scriptedAuth(
  adminRoutes: (request: OnBaseApiRequest) => { status: number; body: unknown } | undefined,
  apiRoutes: (request: OnBaseApiRequest) => { status: number; body: unknown } | undefined = () => undefined
): Scripted {
  const apiRequests: OnBaseApiRequest[] = [];
  const adminRequests: OnBaseApiRequest[] = [];
  return {
    apiRequests,
    adminRequests,
    auth: {
      kind: 'oauth',
      api: (request) => {
        apiRequests.push(request);
        const routed = apiRoutes(request) ?? documentApiDefault(request);
        if (!routed) return Promise.resolve(`Unscripted Document API route ${request.method} ${request.path}`);
        return Promise.resolve({
          status: routed.status,
          contentType: 'application/json',
          body: JSON.stringify(routed.body),
        });
      },
      adminApi: (request) => {
        adminRequests.push(request);
        const routed = adminRoutes(request);
        if (!routed) return Promise.resolve(`Unscripted admin route ${request.method} ${request.path}`);
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

function deniedAdminAuth(): OnBaseAuth {
  return {
    kind: 'oauth',
    api: (request) =>
      Promise.resolve(
        documentApiDefault(request)
          ? { status: 200, contentType: 'application/json', body: JSON.stringify(documentApiDefault(request)) }
          : `Unscripted Document API route ${request.method} ${request.path}`
      ),
    adminApi: () =>
      Promise.resolve('The OnBase Administration API is not configured for this organization.'),
    content: () => Promise.resolve('no content in this suite'),
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
      if (request.method === 'GET' && request.path === '/api/disk-groups') {
        return { status: 200, body: DISK_GROUPS };
      }
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

    const created = scripted.adminRequests.find(
      (r) => r.method === 'POST' && r.path === '/api/document-types'
    );
    expect(created?.body).toMatchObject({
      name: 'Employee Profile',
      documentTypeGroupId: '50',
      defaultFileFormatId: '80',
      defaultDiskGroupId: '10',
    });
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

  it('surfaces a missing Administration API configuration as a refusal, not a crash', async () => {
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
    const patched = scripted.adminRequests.find((r) => r.method === 'PATCH');
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
