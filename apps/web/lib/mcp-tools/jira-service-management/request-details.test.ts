/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The two request-detail readers that were narrowing their own payload
 * away: a form description that dropped the field types and the values
 * they accept, and an approvals list that dropped who is being waited on
 * and when it was decided. Both were answering with less than they held.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  getCachedDisplayName: () => 'Test User',
  withPresentationHint: (text: string, hint: string) => `${text}\n\n(Presentation hint: ${hint})`,
}));
jest.mock('../upload-slots', () => ({ createUploadSlot: jest.fn() }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerRequestDetailsTools } from './request-details';
import type { JsmAuth } from './jsm-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text?: string }[];
  isError?: boolean;
}>;

let body: unknown = {};

const stubAuth: JsmAuth = {
  kind: 'pat',
  async fetch() {
    return new Response(JSON.stringify(body), { status: 200 });
  },
} as unknown as JsmAuth;

async function toolsOf(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerRequestDetailsTools(
    server,
    { tenantId: 't' } as unknown as MCPToolContext,
    stubAuth
  );
  return registered;
}

describe('jsm_get_request_type_fields', () => {
  it('carries the type and the values a field accepts', async () => {
    // Both arrive in this very response. Without them the caller has the
    // field id and no idea what to put in it, and jsm_create_request
    // answers a wrong guess with a 400 that names nothing.
    body = {
      requestTypeFields: [
        { fieldId: 'summary', name: 'Summary', required: true, jiraSchema: { type: 'string' } },
        {
          fieldId: 'customfield_10100',
          name: 'Category',
          required: true,
          description: 'Which team picks this up',
          jiraSchema: { type: 'option' },
          validValues: [
            { value: '10001', label: 'Hardware' },
            { value: '10002', label: 'Software' },
          ],
        },
      ],
    };
    const tools = await toolsOf();

    const text =
      (
        await tools.get('jsm_get_request_type_fields')!({
          serviceDeskId: '7',
          requestTypeId: '165',
        })
      ).content[0]?.text ?? '';

    expect(text).toContain('• Summary (summary) - string [REQUIRED]');
    expect(text).toContain('• Category (customfield_10100) - option [REQUIRED]');
    expect(text).toContain('accepts: "Hardware" (id 10001), "Software" (id 10002)');
    expect(text).toContain('Which team picks this up');
  });

  it('leaves a plain field on one line', async () => {
    body = { requestTypeFields: [{ fieldId: 'summary', name: 'Summary', required: false }] };
    const tools = await toolsOf();

    const text =
      (await tools.get('jsm_get_request_type_fields')!({ serviceDeskId: '7', requestTypeId: '1' }))
        .content[0]?.text ?? '';

    expect(text).toContain('• Summary (summary)');
    expect(text).not.toContain('accepts:');
    expect(text).not.toContain('[REQUIRED]');
  });
});

describe('jsm_list_request_approvals', () => {
  it('says whose desk it is on and when it was decided', async () => {
    body = {
      values: [
        {
          id: '1',
          name: 'Manager approval',
          finalDecision: 'approved',
          createdDate: { iso8601: '2026-08-19T09:00:00Z' },
          completedDate: { iso8601: '2026-08-20T10:00:00Z' },
          approvers: [
            { approver: { displayName: 'Amanda Wong' }, approverDecision: 'approved' },
            { approver: { displayName: 'Dana Lin' }, approverDecision: 'pending' },
          ],
        },
      ],
    };
    const tools = await toolsOf();

    const text =
      (await tools.get('jsm_list_request_approvals')!({ issueKey: 'CAS-1' })).content[0]?.text ??
      '';

    // "Manager approval [pending]" does not say whose desk it is on.
    expect(text).toContain('• Manager approval [approved]');
    expect(text).toContain('decided 2026-08-20T10:00:00Z');
    expect(text).toContain('approvers: Amanda Wong (approved), Dana Lin (pending)');
  });

  it('reads the decision off finalDecision, not a key JSM does not send', async () => {
    // `status` was rendering "[undefined]" on every row.
    body = {
      values: [
        { id: '2', name: 'Security review', createdDate: { iso8601: '2026-08-19T09:00:00Z' } },
      ],
    };
    const tools = await toolsOf();

    const text =
      (await tools.get('jsm_list_request_approvals')!({ issueKey: 'CAS-2' })).content[0]?.text ??
      '';

    expect(text).not.toContain('undefined');
    expect(text).toContain('• Security review [unknown] — raised 2026-08-19T09:00:00Z');
  });
});
