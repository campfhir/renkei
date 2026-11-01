/**
 * The service image allow-list's routes: what the admin form sends reaches
 * the sandbox worker as checked (a credential is a pair, the secret passes
 * through once and is never answered back), and the worker's answers come
 * back as the form shows them — the tag it dropped, a duplicate refused,
 * the defaults restored, the area switched off. The worker itself (its
 * normalization, its seeded images) is replaced: what it does is its own
 * suite's (and the sandbox stub's, for the browser). These were
 * code-services.spec.ts's answers read through the page; the form's rules
 * are app/(app)/admin/code-services/image-rule-forms.model.test.ts.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sandboxServicesEnabled: jest.fn(),
  sbImageRulesList: jest.fn(),
  sbImageRuleSet: jest.fn(),
  sbImageRuleDelete: jest.fn(),
  sbImageRulesRestore: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { DELETE, PUT } from './[ruleId]/route';
import { POST as restore } from './restore/route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const sandbox = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');

const RULE_ID = '6f0c3a52-8a8f-4d5e-9a49-2f6a8c1d0b11';
const REGISTRY_RULE = {
  id: RULE_ID,
  pattern: 'acme1.azurecr.io',
  note: 'Our platform team’s registry',
  registryUsername: 'sp-renkei-pull',
};

const request = (method: string, body?: unknown) =>
  new NextRequest('http://test.local/api/admin/code-services/rules', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (ruleId: string) => ({ params: Promise.resolve({ ruleId }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
  sandbox.sandboxServicesEnabled.mockResolvedValue(true);
});

describe('adding a rule', () => {
  it('hands the worker the rule with its credential pair, and answers the rule without the secret', async () => {
    sandbox.sbImageRuleSet.mockResolvedValue({
      ok: true,
      val: { rule: REGISTRY_RULE, dropped: null },
    });
    const response = await POST(
      request('POST', {
        pattern: 'ACME1.AZURECR.IO/',
        note: 'Our platform team’s registry',
        registryUsername: 'sp-renkei-pull',
        registrySecret: 'super-secret-value',
      })
    );
    expect(response.status).toBe(201);
    expect(sandbox.sbImageRuleSet).toHaveBeenCalledWith({
      pattern: 'ACME1.AZURECR.IO/',
      note: 'Our platform team’s registry',
      registryUsername: 'sp-renkei-pull',
      registrySecret: 'super-secret-value',
    });
    const body = await response.json();
    expect(body).toEqual({ rule: REGISTRY_RULE, dropped: null });
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
  });

  it('passes on the tag the worker dropped, for the form to say so', async () => {
    sandbox.sbImageRuleSet.mockResolvedValue({
      ok: true,
      val: {
        rule: {
          id: RULE_ID,
          pattern: 'docker.io/bitnami/postgresql',
          note: null,
          registryUsername: null,
        },
        dropped: 'the tag 16',
      },
    });
    const response = await POST(request('POST', { pattern: 'bitnami/postgresql:16' }));
    expect((await response.json()).dropped).toBe('the tag 16');
  });

  it('a duplicate the worker refuses comes back as a conflict, in its words', async () => {
    sandbox.sbImageRuleSet.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'exists',
        message: 'docker.io/library/postgres already exists',
        status: 409,
      },
    });
    const response = await POST(request('POST', { pattern: 'postgres' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'docker.io/library/postgres already exists' });
  });

  it('refuses half a credential before asking the worker', async () => {
    const response = await POST(
      request('POST', { pattern: 'acme1.azurecr.io', registryUsername: 'sp' })
    );
    expect(response.status).toBe(400);
    expect(sandbox.sbImageRuleSet).not.toHaveBeenCalled();
  });
});

describe('editing and deleting a rule', () => {
  it('a removal of the credential reaches the worker for that rule', async () => {
    sandbox.sbImageRuleSet.mockResolvedValue({
      ok: true,
      val: { rule: { ...REGISTRY_RULE, registryUsername: null }, dropped: null },
    });
    const response = await PUT(
      request('PUT', { pattern: 'acme1.azurecr.io', note: null, clearCredential: true }),
      params(RULE_ID)
    );
    expect(response.status).toBe(200);
    expect(sandbox.sbImageRuleSet).toHaveBeenCalledWith({
      id: RULE_ID,
      pattern: 'acme1.azurecr.io',
      note: null,
      clearCredential: true,
    });
    expect((await response.json()).rule.registryUsername).toBeNull();
  });

  it('deletes through the worker; a rule id that is not one is not found', async () => {
    sandbox.sbImageRuleDelete.mockResolvedValue({ ok: true, val: undefined });
    expect((await DELETE(request('DELETE'), params(RULE_ID))).status).toBe(200);
    expect(sandbox.sbImageRuleDelete).toHaveBeenCalledWith(RULE_ID);
    expect((await DELETE(request('DELETE'), params('nope'))).status).toBe(404);
  });
});

describe('the list and the defaults', () => {
  it('lists what the worker holds', async () => {
    sandbox.sbImageRulesList.mockResolvedValue({ ok: true, val: [REGISTRY_RULE] });
    expect(await (await GET(request('GET'))).json()).toEqual({ rules: [REGISTRY_RULE] });
  });

  it('restoring answers how many defaults came back', async () => {
    sandbox.sbImageRulesRestore.mockResolvedValue({ ok: true, val: { added: 1, rules: [] } });
    expect(await (await restore(request('POST'))).json()).toEqual({ added: 1, rules: [] });
  });

  it('says the area is off when the deployment offers no services', async () => {
    sandbox.sandboxServicesEnabled.mockResolvedValue(false);
    const response = await GET(request('GET'));
    expect(response.status).toBe(503);
    expect((await response.json()).enabled).toBe(false);
  });

  it('is an operator’s', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await GET(request('GET'))).status).toBe(401);
    expect((await restore(request('POST'))).status).toBe(401);
  });
});
