/**
 * The ADManager Plus instance registry's routes, on the memory store:
 * create, read back, edit (the reset-password template set and cleared),
 * delete, the transport-security guard (plaintext refused for production
 * and for a public host, allowed for a private lab host, and refused again
 * on an edit that relabels it production), and the reachability test's
 * fail-closed answer with no worker. These were admanager.spec.ts's saves
 * read back through the page (and the retry loops they needed); the forms'
 * rules are app/(app)/admin/admanager/*.model.test.ts.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET as list, POST as create } from './route';
import { DELETE, GET, PATCH } from './[instanceId]/route';
import { POST as probe } from './probe/route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const request = (method: string, body?: unknown) =>
  new NextRequest('http://test.local/api/admin/admanager', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (instanceId: string) => ({ params: Promise.resolve({ instanceId }) });

const instance = (more: Record<string, unknown> = {}) => ({
  name: 'ADManager Plus prod',
  environment: 'prod',
  baseUrl: 'https://admp.example.com:8080',
  tlsVerify: true,
  allowInsecureHttp: false,
  resetPasswordTemplateName: null,
  enabled: true,
  ...more,
});

async function created(body: Record<string, unknown>): Promise<string> {
  const response = await create(request('POST', body));
  expect(response.status).toBe(201);
  const { id } = await response.json();
  return id;
}

async function read(instanceId: string): Promise<Record<string, unknown>> {
  const response = await GET(request('GET'), params(instanceId));
  expect(response.status).toBe(200);
  return (await response.json()).instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DELEGATE_WORKER_URL;
  delete process.env.DELEGATE_WORKER_API_KEY;
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue({ subject: 'operator', roles: ['renkei-operator'] });
});

afterEach(() => resetDataStore());

describe('the registry', () => {
  it('creates an instance with its reset-password template, lists it and reads it back', async () => {
    const id = await created(
      instance({ resetPasswordTemplateName: 'Reset Password – must change at next logon' })
    );
    const listed = await (await list(request('GET'))).json();
    expect(listed.instances.map((row: { id: string }) => row.id)).toEqual([id]);
    expect(await read(id)).toMatchObject({
      name: 'ADManager Plus prod',
      baseUrl: 'https://admp.example.com:8080',
      resetPasswordTemplateName: 'Reset Password – must change at next logon',
    });
  });

  it('an edit changes the environment and template; a null template clears it', async () => {
    const id = await created(instance({ resetPasswordTemplateName: 'Old' }));
    const edited = await PATCH(
      request(
        'PATCH',
        instance({ environment: 'staging', resetPasswordTemplateName: 'Helpdesk Reset Template' })
      ),
      params(id)
    );
    expect(edited.status).toBe(200);
    expect(await read(id)).toMatchObject({
      environment: 'staging',
      resetPasswordTemplateName: 'Helpdesk Reset Template',
    });

    await PATCH(request('PATCH', instance({ environment: 'staging' })), params(id));
    expect((await read(id)).resetPasswordTemplateName ?? null).toBeNull();
  });

  it('deletes an instance, and then it is gone', async () => {
    const id = await created(instance());
    expect((await DELETE(request('DELETE'), params(id))).status).toBe(200);
    expect((await GET(request('GET'), params(id))).status).toBe(404);
    expect((await DELETE(request('DELETE'), params(id))).status).toBe(404);
  });

  it('refuses a second instance by the same name', async () => {
    await created(instance());
    expect((await create(request('POST', instance()))).status).toBe(409);
  });

  it('is an operator’s', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await list(request('GET'))).status).toBe(401);
    expect((await create(request('POST', instance()))).status).toBe(401);
  });
});

describe('transport security off', () => {
  const plaintext = (more: Record<string, unknown> = {}) =>
    instance({
      name: 'ADManager Plus lab',
      baseUrl: 'http://127.0.0.1:8080',
      allowInsecureHttp: true,
      ...more,
    });

  it('is refused for a production instance', async () => {
    const response = await create(request('POST', plaintext()));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/production instance must use https/);
  });

  it('is refused for a lab instance on a public host', async () => {
    const response = await create(
      request('POST', plaintext({ environment: 'lab', baseUrl: 'http://203.0.113.9:8080' }))
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/only allowed for a host on a private network/);
  });

  it('is allowed for a lab instance on a private host, stored as such, and audited', async () => {
    const id = await created(plaintext({ environment: 'lab' }));
    expect(await read(id)).toMatchObject({ allowInsecureHttp: true, environment: 'lab' });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admanager.instance.insecure_transport_enabled' })
    );
  });

  it('an edit relabelling it production is refused; turning protection back on saves', async () => {
    const id = await created(plaintext({ environment: 'lab' }));
    const relabelled = await PATCH(
      request('PATCH', plaintext({ environment: 'prod' })),
      params(id)
    );
    expect(relabelled.status).toBe(400);
    expect((await read(id)).environment).toBe('lab');

    const secured = await PATCH(
      request(
        'PATCH',
        plaintext({
          environment: 'lab',
          baseUrl: 'https://127.0.0.1:8443',
          allowInsecureHttp: false,
        })
      ),
      params(id)
    );
    expect(secured.status).toBe(200);
    expect(await read(id)).toMatchObject({ allowInsecureHttp: false, tlsVerify: true });
  });
});

describe('the reachability test', () => {
  it('fails closed with no ADManager Plus worker configured', async () => {
    const response = await probe(
      request('POST', { baseUrl: 'https://admp.example.com:8080', tlsVerify: true })
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'The ADManager Plus service is not configured on this deployment',
    });
  });

  it('refuses a URL it could not dial', async () => {
    const response = await probe(request('POST', { baseUrl: 'http://plain.example' }));
    expect(response.status).toBe(400);
  });
});
