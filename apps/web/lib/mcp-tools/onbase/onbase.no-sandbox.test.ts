/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * OnBase, with no live instance behind the tools. Mirrors
 * fileshares.no-sandbox.test.ts: every registered tool, driven for real
 * through registerOnbaseTools, turns a denied auth into a clean errText()
 * rather than crashing — the guarantee that matters because no OnBase
 * sandbox exists to test against at all (the design doc's open question
 * #3), so this suite is what proves the failure path.
 */

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOnbaseTools } from './index';
import { deniedOnbaseAuth } from './onbase-auth';
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

function tools(): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerOnbaseTools(server, context(), deniedOnbaseAuth());
  return registered;
}

const ARGS: Record<string, Record<string, unknown>> = {
  onbase_search_documents: { documentType: 'Invoices' },
  onbase_run_custom_query: { customQuery: 'Recent Invoices' },
  onbase_get_document: { documentId: '42' },
  onbase_read_document: { documentId: '42' },
  // download builds a link locally — it succeeds even with denied auth, so
  // it is exercised separately below.
  onbase_list_document_types: {},
  onbase_list_keyword_types: {},
  onbase_list_custom_queries: {},
  onbase_list_notes: { documentId: '42' },
  onbase_get_document_history: { documentId: '42' },
  onbase_archive_document: { uploadId: '11111111-2222-3333-4444-555555555555', documentType: 'Invoices' },
  onbase_update_keywords: { documentId: '42', keywords: [{ type: 'Vendor', values: ['Acme'] }] },
  onbase_add_note: { documentId: '42', noteType: 'Sticky', text: 'hello' },
  onbase_reindex_document: { documentId: '42', targetDocumentType: 'Invoices' },
};

test('every OnBase tool answers a denied auth with a clean error', async () => {
  const registered = tools();
  expect([...registered.keys()].sort()).toEqual(
    [...Object.keys(ARGS), 'onbase_download_document', 'onbase_request_document_upload'].sort()
  );
  for (const [name, handler] of registered) {
    if (!(name in ARGS)) continue;
    const result = await handler(ARGS[name]);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBeTruthy();
  }
});

test('the download link needs no API call and stays session-guarded', async () => {
  const registered = tools();
  const result = await registered.get('onbase_download_document')!({ documentId: '42' });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('/api/tenant/tenant-1/onbase/documents/42/content');
});

test('the upload request fails cleanly without a database', async () => {
  const registered = tools();
  const result = await registered.get('onbase_request_document_upload')!({ filename: 'a.pdf' });
  expect(result.isError).toBe(true);
});
