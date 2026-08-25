/**
 * The failure this guards is a link that looks right and is unusable: a
 * portal URL for a normal project 404s, and a browse URL sent to a
 * customer asks them to log into a Jira they have no licence for.
 */

import {
  clearProjectTypeCache,
  issueLinkTargets,
  issueLinksMarkdown,
  isServiceDeskProject,
  projectKeyOf,
} from './issue-urls';
import type { JiraAuth } from './jira-auth';

const fetchMock = jest.fn();
const auth: JiraAuth = { kind: 'oauth', fetch: (_scopes, path) => fetchMock(path) };
const SITE = 'https://nems.atlassian.net';

function serveProject(projectTypeKey: string | null, ok = true): void {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => (projectTypeKey === null ? {} : { projectTypeKey }),
  }));
}

beforeEach(() => clearProjectTypeCache());

describe('projectKeyOf', () => {
  it('takes the project prefix off an issue key', () => {
    expect(projectKeyOf('ENG-789')).toBe('ENG');
    // Keys can contain digits and hyphens; the LAST hyphen is the split.
    expect(projectKeyOf('ABC-DEF-12')).toBe('ABC-DEF');
    expect(projectKeyOf('ENG')).toBe('ENG');
  });
});

describe('issueLinkTargets', () => {
  it('gives a service-desk ticket both the agent and the customer view', async () => {
    serveProject('service_desk');
    const links = await issueLinkTargets(SITE, auth, 'ENG-789');
    expect(links).toEqual([
      { label: 'Open in Jira', url: `${SITE}/browse/ENG-789` },
      {
        label: 'Customer portal',
        url: `${SITE}/servicedesk/customer/portals/all/requests/ENG-789`,
      },
    ]);
  });

  it('gives an ordinary project the browse link only', async () => {
    // A portal URL here would 404 — worse than no link at all.
    serveProject('software');
    const links = await issueLinkTargets(SITE, auth, 'SCRUM-1');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(`${SITE}/browse/SCRUM-1`);
  });

  it('falls back to browse-only when the project cannot be read', async () => {
    serveProject(null, false);
    const links = await issueLinkTargets(SITE, auth, 'ENG-789');
    expect(links).toHaveLength(1);
  });

  it('never throws a link decoration into a write that already succeeded', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      throw new Error('network down');
    });
    await expect(issueLinkTargets(SITE, auth, 'ENG-789')).resolves.toHaveLength(1);
  });

  it('looks a project up once, however many issues it decorates', async () => {
    serveProject('service_desk');
    await issueLinkTargets(SITE, auth, 'ENG-1');
    await issueLinkTargets(SITE, auth, 'ENG-2');
    await issueLinkTargets(SITE, auth, 'ENG-3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps separate answers for separate projects', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        projectTypeKey: String(path).includes('/HELP') ? 'service_desk' : 'software',
      }),
    }));
    expect(await isServiceDeskProject(SITE, auth, 'HELP')).toBe(true);
    expect(await isServiceDeskProject(SITE, auth, 'SCRUM')).toBe(false);
  });
});

describe('issueLinksMarkdown', () => {
  it('renders links the card can parse back out', async () => {
    serveProject('service_desk');
    const markdown = await issueLinksMarkdown(SITE, auth, 'ENG-789');
    expect(markdown).toBe(
      `[Open in Jira](${SITE}/browse/ENG-789) · ` +
        `[Customer portal](${SITE}/servicedesk/customer/portals/all/requests/ENG-789)`
    );
  });
});
