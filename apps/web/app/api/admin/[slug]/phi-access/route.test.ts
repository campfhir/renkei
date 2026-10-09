/**
 * The operator's read of the PHI access trail: operator-only, scoped to
 * the tenant the slug names, narrowed to one subject when asked, and a
 * `before` that is not a date is a 400 rather than a silent full read.
 * The listing itself is covered against a real database in
 * lib/phi-access.db.test.ts; this pins the route's contract around it.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@/lib/tenant-slug', () => ({ tenantForSlug: jest.fn() }));
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn(() => ({ ok: true, val: {} })) }));
jest.mock('@/lib/phi-access', () => ({ listPhiAccessEvents: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET } from './route';

const { checkAccess } = jest.requireMock<{ checkAccess: jest.Mock }>('@/lib/access');
const { tenantForSlug } = jest.requireMock<{ tenantForSlug: jest.Mock }>('@/lib/tenant-slug');
const { listPhiAccessEvents } = jest.requireMock<{ listPhiAccessEvents: jest.Mock }>(
  '@/lib/phi-access'
);

const params = Promise.resolve({ slug: 'acme' });
const get = (query = '') =>
  GET(new NextRequest(`http://renkei.test/api/admin/acme/phi-access${query}`), { params });

beforeEach(() => {
  jest.clearAllMocks();
  tenantForSlug.mockResolvedValue({ id: 'tenant-1', slug: 'acme' });
  checkAccess.mockResolvedValue({ subject: 'operator-1' });
  listPhiAccessEvents.mockResolvedValue([
    {
      id: 'e-1',
      subject: 'alice',
      connector: 'mirth',
      action: 'read',
      toolName: 'mirth_get_message',
    },
  ]);
});

describe('GET /api/admin/[slug]/phi-access', () => {
  it('is operator-only and tenant-scoped', async () => {
    checkAccess.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect(listPhiAccessEvents).not.toHaveBeenCalled();

    tenantForSlug.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
  });

  it("lists the org trail, or one person's, newest first with the asked-for page", async () => {
    const whole = await get();
    expect(whole.status).toBe(200);
    expect(await whole.json()).toEqual({
      events: [expect.objectContaining({ toolName: 'mirth_get_message' })],
    });
    expect(listPhiAccessEvents).toHaveBeenLastCalledWith({}, 'tenant-1', {
      subject: undefined,
      limit: 100,
      before: undefined,
    });

    await get('?subject=alice&limit=25&before=2026-10-01T00:00:00Z');
    expect(listPhiAccessEvents).toHaveBeenLastCalledWith({}, 'tenant-1', {
      subject: 'alice',
      limit: 25,
      before: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('refuses a `before` that is not a date, and ignores a nonsense limit', async () => {
    expect((await get('?before=yesterday')).status).toBe(400);
    expect(listPhiAccessEvents).not.toHaveBeenCalled();
    await get('?limit=lots');
    expect(listPhiAccessEvents).toHaveBeenLastCalledWith(
      {},
      'tenant-1',
      expect.objectContaining({ limit: 100 })
    );
  });
});
