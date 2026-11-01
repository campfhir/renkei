/**
 * The chat archive preference through GET/PUT /api/preferences, on the
 * memory store: what chat-archive.spec.ts checked through a page before —
 * a window saves and reads back, a window longer than the organization
 * keeps chats is refused (so a stale page cannot save around the field's
 * own check), and null goes back to never. The form's rules are
 * chat-archive-form.model.test.ts.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateSettingsCache, setOrgSettings } from '@renkei/settings';
import { GET, PUT } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

let subject = 0;

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateSettingsCache();
  // A fresh person each test: the preference reader caches per subject.
  subject += 1;
  mockGetSession.mockResolvedValue({ subject: `person-${subject}@example.com`, roles: [] });
});

afterEach(() => {
  resetDataStore();
  invalidateSettingsCache();
});

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/preferences', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

async function storedDays(): Promise<unknown> {
  const response = await GET(new NextRequest('http://test.local/api/preferences'));
  expect(response.status).toBe(200);
  const body: { chatArchive: { afterDays: unknown } } = await response.json();
  return body.chatArchive.afterDays;
}

describe('PUT /api/preferences — chatArchive', () => {
  it('starts as never', async () => {
    expect(await storedDays()).toBeNull();
  });

  it('a window the organization allows is stored and read back', async () => {
    const response = await put({ chatArchive: { afterDays: 30 } });
    expect(response.status).toBe(200);
    expect((await response.json()).chatArchive).toEqual({ afterDays: 30 });
    expect(await storedDays()).toBe(30);
  });

  it('refuses a window longer than the organization keeps chats, keeping what was stored', async () => {
    await setOrgSettings({ chatRetentionDays: 90 });
    invalidateSettingsCache();
    await put({ chatArchive: { afterDays: 30 } });

    const refused = await put({ chatArchive: { afterDays: 91 } });

    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe(
      'Archiving cannot be longer than the organization keeps chats (90 days)'
    );
    expect(await storedDays()).toBe(30);
    expect((await put({ chatArchive: { afterDays: 90 } })).status).toBe(200);
  });

  it('with retention off, any whole number of days up to the field’s own ceiling is taken', async () => {
    await setOrgSettings({ chatRetentionDays: 0 });
    invalidateSettingsCache();
    expect((await put({ chatArchive: { afterDays: 1000 } })).status).toBe(200);
    expect(await storedDays()).toBe(1000);
  });

  it('refuses a fraction, zero or a string', async () => {
    for (const afterDays of [2.5, 0, '30']) {
      expect((await put({ chatArchive: { afterDays } })).status).toBe(400);
    }
    expect(await storedDays()).toBeNull();
  });

  it('null goes back to never', async () => {
    await put({ chatArchive: { afterDays: 30 } });
    expect((await put({ chatArchive: { afterDays: null } })).status).toBe(200);
    expect(await storedDays()).toBeNull();
  });

  it('a save of another preference leaves the archive window alone', async () => {
    await put({ chatArchive: { afterDays: 30 } });
    await put({ theme: { mode: 'dark' } });
    expect(await storedDays()).toBe(30);
  });

  it('needs a signed-in person', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await put({ chatArchive: { afterDays: 30 } })).status).toBe(401);
  });
});
