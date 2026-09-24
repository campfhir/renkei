/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * A space's screens against a fake Jira site: which screens it shows for
 * the work types asked about, and which OTHER spaces show them too — found
 * from the screen up, since one screen can sit in many schemes.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import { FAKE_BASE, opsScreensSite } from './fake-site.fixture';
import { otherSpacesOnScreens, readSpaceScreens } from './space-screens';

const access: JiraAdminAccess = {
  cloudId: 'cloud-1',
  siteUrl: 'https://acme.atlassian.net',
  accountId: 'acct-1',
  authHeader: 'Bearer t',
};
const scope = { tenantId: 'tenant-1', subject: 'subject-1' };

let site: Record<string, [number, unknown]>;

beforeEach(() => {
  site = opsScreensSite();
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const path = String(input).slice(FAKE_BASE.length);
    const [status, body] = site[path] ?? [404, { errorMessages: ['No such thing.'] }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

describe('readSpaceScreens', () => {
  it('finds each screen once, with what the space shows it for and its tabs', async () => {
    const read = await readSpaceScreens(scope, access, {
      spaceId: '10000',
      issueTypeIds: ['10001', '10002'],
    });
    if (!read.ok) throw new Error(read.reason);
    expect(read.screens).toEqual([
      { id: '41', name: 'OPS: Create', uses: ['create'], tabs: [{ id: '410', name: 'Field Tab' }] },
      // Bug's scheme names only a default, which covers all three.
      {
        id: '42',
        name: 'Shared bug screen',
        uses: ['create', 'edit', 'view'],
        tabs: [{ id: '420', name: 'Details' }],
      },
      {
        id: '40',
        name: 'OPS: Edit/View',
        uses: ['edit', 'view'],
        tabs: [
          { id: '400', name: 'Field Tab' },
          { id: '401', name: 'Details' },
        ],
      },
    ]);
  });

  it('takes a work type without a mapping of its own to the default screen scheme', async () => {
    const read = await readSpaceScreens(scope, access, {
      spaceId: '10000',
      issueTypeIds: ['10001'],
    });
    if (!read.ok) throw new Error(read.reason);
    expect(read.screens.map((screen) => screen.name)).toEqual(['OPS: Create', 'OPS: Edit/View']);
  });

  it('refuses a partial picture when a screen’s tabs cannot be read', async () => {
    site['/rest/api/3/screens/40/tabs'] = [403, { errorMessages: ['Nope.'] }];
    const read = await readSpaceScreens(scope, access, {
      spaceId: '10000',
      issueTypeIds: ['10001'],
    });
    expect(read).toEqual({
      ok: false,
      reason: expect.stringMatching(/^The tabs of screen OPS: Edit\/View: Jira refused \(403\)/),
    });
  });
});

describe('otherSpacesOnScreens', () => {
  it('names the other spaces behind each screen, and never the space itself', async () => {
    const sharing = await otherSpacesOnScreens(scope, access, ['41', '40', '42'], '10000');
    expect(sharing && Object.fromEntries(sharing)).toEqual({
      '41': { spaces: [], more: false },
      '40': { spaces: [], more: false },
      '42': { spaces: ['HR'], more: false },
    });
  });

  it('says it cannot tell, rather than "nobody", when Jira will not say', async () => {
    site['/rest/api/3/issuetypescreenscheme/13/project?maxResults=50'] = [500, {}];
    expect(await otherSpacesOnScreens(scope, access, ['42'], '10000')).toBeNull();
  });
});
