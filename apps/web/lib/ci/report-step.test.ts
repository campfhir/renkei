/**
 * The report step for a pipeline written by hand, on the memory store:
 * taking it records how the host's tokens name the project's repository —
 * which is how a report then finds the project — and answers the YAML to
 * copy; when that name cannot be learned, or Renkei does not know its own
 * address, nothing is recorded and no step is handed out.
 */

jest.mock('@/lib/code/bitbucket-browse', () => ({
  ...jest.requireActual('@/lib/code/bitbucket-browse'),
  bitbucketAuthOf: jest.fn(() => ({ kind: 'oauth' })),
}));
jest.mock('@/lib/mcp-tools/bitbucket/client', () => ({
  ...jest.requireActual('@/lib/mcp-tools/bitbucket/client'),
  bbJson: jest.fn(),
}));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { getProjectRow } from '@/lib/chat/projects';
import type { CodeRepoProject } from './pipeline-builder';
import { reportStep } from './report-step';

const { bbJson } = jest.requireMock<{ bbJson: jest.Mock }>('@/lib/mcp-tools/bitbucket/client');

const caller = { subject: 'auth0|ada', origin: 'https://renkei.example/' };
const UUID = '8F2C1A9E-0000-4000-8000-00000000ABCD';

async function project(provider: string, fullName: string): Promise<CodeRepoProject> {
  const id = await getDataStore().chatProjects.create({
    ownerSubject: 'auth0|ada',
    name: 'Billing',
    description: null,
    toolConfig: null,
    repo: { provider, fullName, branch: 'main' },
  });
  const row = await getProjectRow(id);
  if (!row?.repo) throw new Error('no code project');
  return { ...row, repo: row.repo };
}

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
});
afterEach(() => resetDataStore());

describe('on GitHub', () => {
  it('records the repository as its tokens name it, owner/name in lower case, and hands out the job', async () => {
    const repo = await project(GITHUB, 'Acme/Billing-API');
    const outcome = await reportStep(caller, 'github', repo, 'dev');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await getDataStore().ciRepoKeys.projectsFor('github', 'acme/billing-api')).toEqual([
      repo.id,
    ]);
    expect(outcome.step.environment).toBe('dev');
    expect(outcome.step.snippet).toContain('environment: dev');
    expect(outcome.step.snippet).toContain('id-token: write');
    // It reports to this Renkei, by its address without the trailing slash.
    expect(outcome.step.snippet).toContain("'https://renkei.example/api/deployments/report'");
    expect(outcome.step.where).toContain('the workflow that deploys dev');
    // GitHub's name is in the project already: the host is not asked.
    expect(bbJson).not.toHaveBeenCalled();
  });

  it('taken again, it is the same record, not a second one', async () => {
    const repo = await project(GITHUB, 'acme/billing');
    await reportStep(caller, 'github', repo, 'dev');
    await reportStep(caller, 'github', repo, 'production');
    expect(await getDataStore().ciRepoKeys.projectsFor('github', 'acme/billing')).toEqual([
      repo.id,
    ]);
  });
});

describe('on Bitbucket', () => {
  it('reads the repository’s UUID with the person’s grant and keeps it bare and lower case', async () => {
    bbJson.mockResolvedValue({ ok: true, body: { uuid: `{${UUID}}`, full_name: 'acme/billing' } });
    const repo = await project(ATLASSIAN_BITBUCKET, 'acme/billing');
    const outcome = await reportStep(caller, 'bitbucket', repo, 'production');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(bbJson).toHaveBeenCalledWith(
      expect.anything(),
      ['repository'],
      '/repositories/acme/billing'
    );
    expect(await getDataStore().ciRepoKeys.projectsFor('bitbucket', UUID.toLowerCase())).toEqual([
      repo.id,
    ]);
    expect(outcome.step.snippet).toContain('deployment: production');
    expect(outcome.step.snippet).toContain('oidc: true');
    expect(outcome.step.where).toContain('bitbucket-pipelines.yml');
  });

  it('is refused, with nothing recorded, when Bitbucket does not say', async () => {
    bbJson.mockResolvedValue({ ok: false, error: 'Connect Bitbucket first.' });
    const repo = await project(ATLASSIAN_BITBUCKET, 'acme/billing');
    expect(await reportStep(caller, 'bitbucket', repo, 'dev')).toEqual({
      ok: false,
      status: 502,
      error:
        'Bitbucket did not say how its tokens name this repository: Connect Bitbucket first.; the report step was not prepared.',
    });
    // An answer with no UUID in it is the same.
    bbJson.mockResolvedValue({ ok: true, body: {} });
    expect(await reportStep(caller, 'bitbucket', repo, 'dev')).toMatchObject({
      ok: false,
      status: 502,
    });
    expect(await getDataStore().ciRepoKeys.projectsFor('bitbucket', UUID.toLowerCase())).toEqual(
      []
    );
  });
});

describe('a Renkei that does not know its own address', () => {
  it('has nowhere for a pipeline to report to: refused before anything is asked or recorded', async () => {
    const repo = await project(GITHUB, 'acme/billing');
    const outcome = await reportStep({ subject: 'auth0|ada', origin: '' }, 'github', repo, 'dev');
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(!outcome.ok && outcome.error).toContain('does not know its own address');
    expect(await getDataStore().ciRepoKeys.projectsFor('github', 'acme/billing')).toEqual([]);
  });
});
