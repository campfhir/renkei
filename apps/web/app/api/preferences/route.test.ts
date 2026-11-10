/**
 * Preferences through GET/PATCH /api/preferences, on the
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
import { GET, PATCH } from './route';

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

const send = (body: unknown) =>
  PATCH(
    new NextRequest('http://test.local/api/preferences', {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  );

async function storedDays(): Promise<unknown> {
  const response = await GET(new NextRequest('http://test.local/api/preferences'));
  expect(response.status).toBe(200);
  const body: { chatArchive: { afterDays: unknown } } = await response.json();
  return body.chatArchive.afterDays;
}

describe('PATCH /api/preferences — chatArchive', () => {
  it('starts as never', async () => {
    expect(await storedDays()).toBeNull();
  });

  it('a window the organization allows is stored and read back', async () => {
    const response = await send({ chatArchive: { afterDays: 30 } });
    expect(response.status).toBe(200);
    expect((await response.json()).chatArchive).toEqual({ afterDays: 30 });
    expect(await storedDays()).toBe(30);
  });

  it('refuses a window longer than the organization keeps chats, keeping what was stored', async () => {
    await setOrgSettings({ chatRetentionDays: 90 });
    invalidateSettingsCache();
    await send({ chatArchive: { afterDays: 30 } });

    const refused = await send({ chatArchive: { afterDays: 91 } });

    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe(
      'Archiving cannot be longer than the organization keeps chats (90 days)'
    );
    expect(await storedDays()).toBe(30);
    expect((await send({ chatArchive: { afterDays: 90 } })).status).toBe(200);
  });

  it('with retention off, any whole number of days up to the field’s own ceiling is taken', async () => {
    await setOrgSettings({ chatRetentionDays: 0 });
    invalidateSettingsCache();
    expect((await send({ chatArchive: { afterDays: 1000 } })).status).toBe(200);
    expect(await storedDays()).toBe(1000);
  });

  it('refuses a fraction, zero or a string', async () => {
    for (const afterDays of [2.5, 0, '30']) {
      expect((await send({ chatArchive: { afterDays } })).status).toBe(400);
    }
    expect(await storedDays()).toBeNull();
  });

  it('null goes back to never', async () => {
    await send({ chatArchive: { afterDays: 30 } });
    expect((await send({ chatArchive: { afterDays: null } })).status).toBe(200);
    expect(await storedDays()).toBeNull();
  });

  it('a save of another preference leaves the archive window alone', async () => {
    await send({ chatArchive: { afterDays: 30 } });
    await send({ theme: { mode: 'dark' } });
    expect(await storedDays()).toBe(30);
  });

  it('needs a signed-in person', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await send({ chatArchive: { afterDays: 30 } })).status).toBe(401);
  });
});

describe('PATCH /api/preferences — notifications', () => {
  const patch = (body: unknown) =>
    PATCH(
      new NextRequest('http://test.local/api/preferences', {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
    );

  async function notifications(): Promise<Record<string, unknown>> {
    const body: { notifications: Record<string, unknown> } = await (
      await GET(new NextRequest('http://test.local/api/preferences'))
    ).json();
    return body.notifications;
  }

  it('changes only the fields named, and answers with the whole document', async () => {
    const before = await notifications();
    const response = await patch({ notifications: { toastCorner: 'bottom-left' } });
    expect(response.status).toBe(200);
    const body: { notifications: Record<string, unknown> } = await response.json();
    expect(body.notifications).toEqual({ ...before, toastCorner: 'bottom-left' });
    expect(await notifications()).toEqual({ ...before, toastCorner: 'bottom-left' });
  });

  it('is idempotent: the same patch twice leaves the same preferences', async () => {
    const change = { notifications: { runStarted: { app: true, email: false, webex: false } } };
    await patch(change);
    const once = await notifications();
    await patch(change);
    expect(await notifications()).toEqual(once);
  });

  it('two patches of different cards sent at once both land', async () => {
    const before = await notifications();
    await Promise.all([
      patch({ notifications: { toastsEnabled: false } }),
      patch({ notifications: { chatReplyDesktop: true, openInSourceApp: false } }),
    ]);
    expect(await notifications()).toEqual({
      ...before,
      toastsEnabled: false,
      chatReplyDesktop: true,
      openInSourceApp: false,
    });
  });

  it('leaves the other preferences alone', async () => {
    await send({ chatArchive: { afterDays: 30 } });
    await patch({ notifications: { toastsEnabled: false } });
    expect(await storedDays()).toBe(30);
  });

  it('refuses a field the preferences do not have, an empty patch, and no notifications', async () => {
    const unknown = await patch({ notifications: { toastsEnabled: false, colour: 'red' } });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe('Not a notification preference: colour.');
    expect((await patch({ notifications: {} })).status).toBe(400);
    expect((await patch({ colour: { mode: 'dark' } })).status).toBe(400);
    expect((await notifications()).toastsEnabled).toBe(true);
  });

  it('is refused when signed out', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await patch({ notifications: { toastsEnabled: false } })).status).toBe(401);
  });
});

describe('PATCH /api/preferences — every document', () => {
  const patch = (body: unknown) =>
    PATCH(
      new NextRequest('http://test.local/api/preferences', {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
    );
  async function all(): Promise<Record<string, Record<string, unknown>>> {
    return (await GET(new NextRequest('http://test.local/api/preferences'))).json();
  }

  it('changes one field of the theme and leaves its other field alone', async () => {
    await patch({ theme: { codeLineNumbers: true } });
    await patch({ theme: { mode: 'dark' } });
    expect((await all()).theme).toEqual({ mode: 'dark', codeLineNumbers: true });
  });

  it('a voice patch twice leaves the same voice preferences', async () => {
    await patch({ voice: { rate: 1.5 } });
    const once = (await all()).voice;
    await patch({ voice: { rate: 1.5 } });
    expect((await all()).voice).toEqual(once);
    expect(once.rate).toBe(1.5);
  });

  it('patches several documents in one request', async () => {
    const response = await patch({ image: { modelId: null }, coachMarks: { autoStart: false } });
    expect(response.status).toBe(200);
    const body: Record<string, Record<string, unknown>> = await response.json();
    expect(body.coachMarks).toEqual({ autoStart: false });
    expect(body.image).toEqual({ modelId: null });
  });

  it('writes nothing when any patch in the request is refused', async () => {
    const response = await patch({ theme: { mode: 'dark' }, voice: { pitch: 3 } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Not a voice preference: pitch.');
    expect((await all()).theme.mode).toBe('auto');
  });

  it('refuses a document that does not exist, and an empty body', async () => {
    const unknown = await patch({ wallpaper: { colour: 'red' } });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe('Not a preference: wallpaper');
    expect((await patch({})).status).toBe(400);
  });
});
