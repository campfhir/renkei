/**
 * Once a preview host is set, the app's own preview addresses stop serving:
 * a page load goes on to the preview host, anything else is told nothing is
 * here.
 */

let host = '';
jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { codePreviewHost: host } }),
}));
jest.mock('@/lib/chat/projects', () => ({ getProjectRow: jest.fn() }));
jest.mock('@/lib/chat/access', () => ({ resolveResourceAccess: jest.fn() }));
jest.mock('@/lib/chat/store', () => ({ getChatRow: jest.fn() }));

import { NextRequest } from 'next/server';
import { mayViewPreview, movedToPreviewHost } from './preview-host-server';

const { getProjectRow } = jest.requireMock<{ getProjectRow: jest.Mock }>('@/lib/chat/projects');
const { resolveResourceAccess } = jest.requireMock<{ resolveResourceAccess: jest.Mock }>(
  '@/lib/chat/access'
);
const { getChatRow } = jest.requireMock<{ getChatRow: jest.Mock }>('@/lib/chat/store');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  host = '';
});

describe('the app’s own preview addresses', () => {
  const request = (method = 'GET') =>
    new NextRequest('https://app.example.com/api/code/preview/tok/a%20b?x=1', { method });

  it('serve as before while no preview host is set', async () => {
    expect(await movedToPreviewHost(request(), '/t/tok/', ['a b'])).toBeNull();
  });

  it('send a page load on to the same preview on the preview host', async () => {
    host = 'preview.example.com';
    const response = await movedToPreviewHost(request(), '/t/tok/', ['a b']);
    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe('https://preview.example.com/t/tok/a%20b?x=1');
  });

  it('answer nothing else once the host is set', async () => {
    host = 'preview.example.com';
    expect((await movedToPreviewHost(request('POST'), '/t/tok/', []))?.status).toBe(404);
  });
});

describe('who may see a member’s preview', () => {
  const code = { id: PROJECT, kind: 'code', repo: { fullName: 'acme/site' } };

  it('anyone the project is shared with, viewers included', async () => {
    resolveResourceAccess.mockResolvedValue({ role: 'viewer' });
    getProjectRow.mockResolvedValue(code);
    expect(await mayViewPreview('ann', PROJECT, null)).toBe(true);
  });

  it('nobody else, and nothing that is not a code project or a chat of it', async () => {
    resolveResourceAccess.mockResolvedValue(null);
    expect(await mayViewPreview('eve', PROJECT, null)).toBe(false);
    resolveResourceAccess.mockResolvedValue({ role: 'owner' });
    getProjectRow.mockResolvedValue({ ...code, kind: 'chat' });
    expect(await mayViewPreview('ann', PROJECT, null)).toBe(false);
    getProjectRow.mockResolvedValue(code);
    getChatRow.mockResolvedValue({ id: CHAT, projectId: 'another' });
    expect(await mayViewPreview('ann', PROJECT, CHAT)).toBe(false);
    getChatRow.mockResolvedValue({ id: CHAT, projectId: PROJECT });
    expect(await mayViewPreview('ann', PROJECT, CHAT)).toBe(true);
    expect(await mayViewPreview('ann', 'not-an-id', null)).toBe(false);
  });
});
