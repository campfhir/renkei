/**
 * Operator removal of a person's encryption key: operator-only, never the
 * operator's own, and when the key service has shredded it the person's
 * sessions end (their next sign-in enrolls afresh) and it is audited.
 * keys.spec.ts checked the end of this through the browser (the leaver's
 * session refused, the operator still enrolled); it keeps the removal
 * pressed through the Access page.
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/delegate-client', () => {
  const shredUserKey = jest.fn();
  return { delegateClient: () => ({ shredUserKey }), __shredUserKey: shredUserKey };
});

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DELETE } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);
const { __shredUserKey: mockShred } = jest.requireMock<{ __shredUserKey: jest.Mock }>(
  '@renkei/delegate-client'
);

const OPERATOR = 'op@example.com';
const LEAVER = 'bob@example.com';
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

async function signedIn(): Promise<void> {
  registerDataStore(createMemoryDataStore());
  const store = getDataStore();
  for (const [id, subject] of [
    ['00000000-0000-4000-8000-000000000701', LEAVER],
    ['00000000-0000-4000-8000-000000000702', LEAVER],
    ['00000000-0000-4000-8000-000000000703', OPERATOR],
  ]) {
    await store.sessions.create({ id, subject, roles: ['renkei-user'], expiresAt: EXPIRES });
  }
}

async function sessionsOf(subject: string): Promise<number> {
  const ids = [
    '00000000-0000-4000-8000-000000000701',
    '00000000-0000-4000-8000-000000000702',
    '00000000-0000-4000-8000-000000000703',
  ];
  const found = await Promise.all(ids.map((id) => getDataStore().sessions.find(id)));
  return found.filter((session) => session?.subject === subject).length;
}

function remove(subject: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/admin/access/${encodeURIComponent(subject)}/keys`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ subject: encodeURIComponent(subject) }) }
  );
}

describe('DELETE /api/admin/access/{subject}/keys', () => {
  beforeEach(async () => {
    mockCheckAccess.mockReset();
    mockAudit.mockReset();
    mockShred.mockReset();
    await signedIn();
  });
  afterAll(() => resetDataStore());

  it('refuses a caller who is not an operator before reaching the key service', async () => {
    mockCheckAccess.mockResolvedValue(null);
    const response = await remove(LEAVER);
    expect(response.status).toBe(401);
    expect(mockShred).not.toHaveBeenCalled();
    expect(await sessionsOf(LEAVER)).toBe(2);
  });

  it('will not remove the operator’s own key from here', async () => {
    mockCheckAccess.mockResolvedValue({ subject: OPERATOR, roles: ['renkei-operator'] });
    const response = await remove(OPERATOR);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Remove your own key from Preferences, not from here.',
    });
    expect(mockShred).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(await sessionsOf(OPERATOR)).toBe(1);
  });

  it('removes the key, ends the person’s sessions only, and audits it', async () => {
    mockCheckAccess.mockResolvedValue({ subject: OPERATOR, roles: ['renkei-operator'] });
    mockShred.mockResolvedValue({ ok: true, val: true });
    const response = await remove(LEAVER);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, shredded: true });
    expect(mockShred).toHaveBeenCalledWith(LEAVER);
    expect(await sessionsOf(LEAVER)).toBe(0);
    expect(await sessionsOf(OPERATOR)).toBe(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: OPERATOR,
        action: 'encryption-key.shredded',
        targetLabel: LEAVER,
      })
    );
  });

  it('with the key service down, says so and leaves the person signed in', async () => {
    mockCheckAccess.mockResolvedValue({ subject: OPERATOR, roles: ['renkei-operator'] });
    mockShred.mockResolvedValue({ ok: false, err: { type: 'unreachable', message: 'down' } });
    const response = await remove(LEAVER);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'The key service could not be reached.' });
    expect(await sessionsOf(LEAVER)).toBe(2);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
