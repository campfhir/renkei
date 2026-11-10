/**
 * The code-project template catalog's admin routes, on the memory store:
 * operator-only, a name and instructions required, a taken name refused,
 * and an edit or delete that finds nothing a 404. project-templates.spec.ts
 * creates one template through the page; the form's own rules are
 * app/(app)/admin/project-templates/project-template-forms.model.test.ts.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, POST } from './route';
import { DELETE, PUT } from './[templateId]/route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockCheckAccess.mockResolvedValue(true);
});

afterEach(() => resetDataStore());

const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://test.local${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const params = (templateId: string) => ({ params: Promise.resolve({ templateId }) });

async function create(body: unknown) {
  return POST(json('/api/admin/project-templates', 'POST', body));
}

async function listed(): Promise<{ id: string; name: string; description: string | null }[]> {
  const response = await GET(json('/api/admin/project-templates', 'GET'));
  const body: { templates: { id: string; name: string; description: string | null }[] } =
    await response.json();
  return body.templates;
}

const TEMPLATE = {
  name: 'Microservice / API service',
  description: 'A focused backend service.',
  instructions: 'Protect the API contract.',
};

describe('the template catalog', () => {
  it('an operator creates a template, trimmed, and it is listed', async () => {
    const response = await create({ ...TEMPLATE, name: '  Microservice / API service  ' });
    expect(response.status).toBe(201);
    expect(await listed()).toEqual([
      expect.objectContaining({
        name: 'Microservice / API service',
        description: 'A focused backend service.',
      }),
    ]);
  });

  it('someone who is not an operator can neither read nor write it', async () => {
    mockCheckAccess.mockResolvedValue(false);
    expect((await GET(json('/api/admin/project-templates', 'GET'))).status).toBe(401);
    expect((await create(TEMPLATE)).status).toBe(401);
    expect((await PUT(json('/x', 'PUT', TEMPLATE), params('t'))).status).toBe(401);
    expect((await DELETE(json('/x', 'DELETE'), params('t'))).status).toBe(401);
  });

  it('refuses a template without a name or instructions', async () => {
    expect((await create({ ...TEMPLATE, name: '  ' })).status).toBe(400);
    expect((await create({ ...TEMPLATE, instructions: '' })).status).toBe(400);
    expect((await create(['not', 'an', 'object'])).status).toBe(400);
    expect(await listed()).toEqual([]);
  });

  it('refuses a second template with a taken name', async () => {
    expect((await create(TEMPLATE)).status).toBe(201);
    const duplicate = await create({ ...TEMPLATE, instructions: 'Something else.' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'A template with that name exists' });
  });

  it('an edit rewrites the row; renaming onto a taken name is refused', async () => {
    await create(TEMPLATE);
    await create({ ...TEMPLATE, name: 'SQL report' });
    const [first] = (await listed()).filter((row) => row.name === TEMPLATE.name);
    const edited = await PUT(
      json(`/api/admin/project-templates/${first!.id}`, 'PUT', {
        ...TEMPLATE,
        name: 'API service',
      }),
      params(first!.id)
    );
    expect(edited.status).toBe(200);
    expect((await listed()).map((row) => row.name).sort()).toEqual(['API service', 'SQL report']);
    const clash = await PUT(
      json(`/api/admin/project-templates/${first!.id}`, 'PUT', { ...TEMPLATE, name: 'SQL report' }),
      params(first!.id)
    );
    expect(clash.status).toBe(409);
  });

  it('a delete removes the row; one that finds nothing is a 404', async () => {
    await create(TEMPLATE);
    const [row] = await listed();
    expect((await DELETE(json('/x', 'DELETE'), params(row!.id))).status).toBe(200);
    expect(await listed()).toEqual([]);
    expect((await DELETE(json('/x', 'DELETE'), params(row!.id))).status).toBe(404);
    expect((await DELETE(json('/x', 'DELETE'), params('not-a-uuid'))).status).toBe(404);
    expect((await PUT(json('/x', 'PUT', TEMPLATE), params(row!.id))).status).toBe(404);
  });
});
