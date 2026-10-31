/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { MCPToolContext } from '../common';

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@/lib/sandbox/service-client', () => ({ sbStatFile: jest.fn() }));

const resolveRef = jest.fn();
const resolveOwner = jest.fn();
jest.mock('./records', () => ({
  resolveRef: (...a: unknown[]) => resolveRef(...a),
  fieldOf: jest.fn(),
}));
jest.mock('./schema', () => ({
  resolveOwner: (...a: unknown[]) => resolveOwner(...a),
  resolveObject: jest.fn(),
}));
jest.mock('./client', () => ({
  rec: (v: unknown) => (typeof v === 'object' && v !== null ? v : {}),
  sfQuery: jest.fn(),
  str: (v: unknown) => (typeof v === 'string' ? v : ''),
}));

import { lookupNames } from '../lookup';
import { registerSalesforcePreviewLookups } from './preview-lookups';
import type { SalesforceAuth } from './salesforce-auth';

const ACCOUNT = '0015e00000AbCdEfGH';
const USER = '0055e00000ZyXwVuTS';

const access = { connector: 'prod' };
const auth = (resolved: unknown): SalesforceAuth =>
  ({ kind: 'oauth', resolve: async () => resolved }) as unknown as SalesforceAuth;

beforeEach(() => {
  resolveRef.mockReset();
  resolveOwner.mockReset();
});

describe('Salesforce preview lookups', () => {
  it('names id-like records and the assignee, and skips what was typed as words', async () => {
    const ctx = {} as MCPToolContext;
    registerSalesforcePreviewLookups(ctx, auth(access));
    resolveRef.mockImplementation(async (_c: unknown, _a: unknown, ref: { record: string }) => ({
      id: ref.record,
      name: 'Acme',
      describe: {},
    }));
    resolveOwner.mockResolvedValue({ id: USER, name: 'Ann Lee', kind: 'User' });
    const names = await lookupNames(ctx, 'salesforce_create_task', {
      subject: 'Call',
      assignee: USER,
      relatedTo: [{ record: ACCOUNT }, { object: 'Account', record: 'Globex' }],
    });
    expect(names).toEqual({ [`record:${ACCOUNT}`]: 'Acme', [`user:${USER}`]: 'Ann Lee' });
    expect(resolveRef).toHaveBeenCalledTimes(1);
  });

  it('leaves names out when there is no access or the read fails', async () => {
    const denied = {} as MCPToolContext;
    registerSalesforcePreviewLookups(denied, auth('Not connected'));
    expect(
      await lookupNames(denied, 'salesforce_add_note', { object: 'Account', record: ACCOUNT })
    ).toEqual({});

    const failing = {} as MCPToolContext;
    registerSalesforcePreviewLookups(failing, auth(access));
    resolveRef.mockRejectedValue(new Error('down'));
    expect(
      await lookupNames(failing, 'salesforce_add_note', { object: 'Account', record: ACCOUNT })
    ).toEqual({});
  });
});
