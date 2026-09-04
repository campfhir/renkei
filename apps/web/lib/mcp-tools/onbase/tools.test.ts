/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The OnBase tools against a scripted API — the behaviors that must
 * survive any refactor:
 *
 *   - names resolve to ids INSIDE the tools (the caller never runs a
 *     lookup errand), and ambiguity is refused with named candidates;
 *   - the search is the two-step handle flow;
 *   - keyword updates READ-MERGE-WRITE (the PUT replaces everything, so
 *     the payload must carry the untouched keywords and the keywordGuid);
 *   - a 300 from the archive POST is a refusal, never a success.
 *
 * The worker seam is faked at the OnBaseAuth boundary; the upload-slot
 * read in archive is faked at @renkei/db.
 */

let slotRow: Record<string, unknown> | undefined;

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({
          where: function whereChain() {
            return { where: whereChain, executeTakeFirst: () => Promise.resolve(slotRow) };
          },
        }),
      }),
    },
  }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOnbaseTools } from './index';
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

const KEYWORD_TYPES = {
  items: [
    { id: '101', name: 'Vendor', dataType: 'Alphanumeric' },
    { id: '102', name: 'Invoice Amount', dataType: 'Currency' },
    { id: '103', name: 'Amount', dataType: 'Currency' },
    { id: '104', name: 'amount', dataType: 'Numeric9' },
  ],
};
const DOCUMENT_TYPES = { items: [{ id: '7', name: 'Invoices' }] };

interface Scripted {
  requests: OnBaseApiRequest[];
  auth: OnBaseAuth;
}

/** An OnBaseAuth whose api() plays scripted routes and records requests. */
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
        const routed =
          routes(request) ??
          (request.path === '/keyword-types'
            ? { status: 200, body: KEYWORD_TYPES }
            : request.path === '/document-types'
              ? { status: 200, body: DOCUMENT_TYPES }
              : request.path === '/document-type-groups'
                ? { status: 200, body: { items: [] } }
                : undefined);
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

function tools(auth: OnBaseAuth): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerOnbaseTools(server, context(), auth);
  return registered;
}

describe('onbase_search_documents', () => {
  it('resolves names to ids and runs the two-step query', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'POST' && request.path === '/documents/queries') {
        return { status: 201, body: { id: 'q-1' } };
      }
      if (request.method === 'GET' && request.path === '/documents/queries/q-1/results') {
        return {
          status: 200,
          body: {
            items: [
              {
                id: '9001',
                displayColumns: [
                  { index: '0', values: ['ACME Invoice 77'] },
                  { index: '1', values: ['Invoices'] },
                  { index: '2', values: ['2026-08-01'] },
                ],
              },
            ],
          },
        };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_search_documents')!({
      documentType: 'invoices',
      keywords: [{ type: 'vendor', value: 'ACME' }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('id 9001');
    expect(result.content[0].text).toContain('ACME Invoice 77');

    const submitted = scripted.requests.find(
      (request) => request.method === 'POST' && request.path === '/documents/queries'
    );
    expect(submitted?.body).toMatchObject({
      queryType: [{ type: 'DocumentType', ids: ['7'] }],
      queryKeywordCollection: [{ typeId: '101', value: 'ACME' }],
    });
  });

  it('refuses an ambiguous keyword name and names the candidates', async () => {
    const scripted = scriptedAuth(() => undefined);
    const result = await tools(scripted.auth).get('onbase_search_documents')!({
      documentType: 'Invoices',
      keywords: [{ type: 'Amount', value: '5000', operator: 'GreaterThan' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('103');
    expect(result.content[0].text).toContain('104');
  });
});

describe('onbase_update_keywords', () => {
  it('reads, merges, and writes the WHOLE collection back', async () => {
    const scripted = scriptedAuth((request) => {
      if (request.method === 'GET' && request.path === '/documents/9001/keywords') {
        return {
          status: 200,
          body: {
            keywordGuid: 'guid-1',
            items: [
              {
                keywords: [
                  { typeId: '101', values: [{ value: 'Old Vendor' }] },
                  { typeId: '102', values: [{ value: '100.00' }] },
                ],
              },
            ],
          },
        };
      }
      if (request.method === 'PUT' && request.path === '/documents/9001/keywords') {
        return { status: 204, body: {} };
      }
      return undefined;
    });
    const result = await tools(scripted.auth).get('onbase_update_keywords')!({
      documentId: '9001',
      keywords: [{ type: 'Vendor', values: ['New Vendor'] }],
    });
    expect(result.isError).toBeUndefined();

    const put = scripted.requests.find((request) => request.method === 'PUT');
    // The untouched Invoice Amount keyword and the integrity guid MUST ride
    // the write — the API replaces everything it is given.
    expect(put?.body).toEqual({
      keywordGuid: 'guid-1',
      items: [
        {
          keywords: [
            { typeId: '101', values: [{ value: 'New Vendor' }] },
            { typeId: '102', values: [{ value: '100.00' }] },
          ],
        },
      ],
    });
  });
});

describe('onbase_archive_document', () => {
  beforeEach(() => {
    slotRow = {
      id: '11111111-2222-3333-4444-555555555555',
      kind: 'onbase-document',
      status: 'completed',
      destination: { onbaseUploadId: 'stage-9' },
      filename: 'invoice.pdf',
      subject: 'subject-1',
    };
  });

  function archiveScript(finalStatus: number, finalBody: unknown): Scripted {
    return scriptedAuth((request) => {
      if (request.path === '/document-types/7/default-keywords') {
        return { status: 200, body: { keywordGuid: 'guid-2', items: [] } };
      }
      if (request.path === '/default-upload-file-types') {
        return { status: 200, body: { id: 'ft-2' } };
      }
      if (request.method === 'POST' && request.path === '/documents') {
        return { status: finalStatus, body: finalBody };
      }
      return undefined;
    });
  }

  it('archives a staged upload under the resolved type', async () => {
    const scripted = archiveScript(201, { id: '9100' });
    const result = await tools(scripted.auth).get('onbase_archive_document')!({
      uploadId: '11111111-2222-3333-4444-555555555555',
      documentType: 'Invoices',
      keywords: [{ type: 'Vendor', values: ['ACME'] }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('9100');

    const posted = scripted.requests.find(
      (request) => request.method === 'POST' && request.path === '/documents'
    );
    expect(posted?.body).toMatchObject({
      documentTypeId: '7',
      fileTypeId: 'ft-2',
      uploads: [{ id: 'stage-9' }],
      keywordCollection: {
        keywordGuid: 'guid-2',
        items: [{ keywords: [{ typeId: '101', values: [{ value: 'ACME' }] }] }],
      },
    });
  });

  it('treats a 300 matched-documents answer as a refusal, not success', async () => {
    const scripted = archiveScript(300, {
      canAddAsNew: true,
      items: [{ id: '9050', canAddAsRevision: true }],
    });
    const result = await tools(scripted.auth).get('onbase_archive_document')!({
      uploadId: '11111111-2222-3333-4444-555555555555',
      documentType: 'Invoices',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('9050');
    expect(result.content[0].text).toContain('storeAsNew');
  });

  it('refuses a slot whose bytes never reached OnBase staging', async () => {
    slotRow = { ...slotRow, destination: {} };
    const scripted = archiveScript(201, { id: '9100' });
    const result = await tools(scripted.auth).get('onbase_archive_document')!({
      uploadId: '11111111-2222-3333-4444-555555555555',
      documentType: 'Invoices',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('never reached OnBase staging');
  });
});
