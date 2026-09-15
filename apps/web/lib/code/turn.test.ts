/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The turn's view of a code project's checkout: usable at once, or made
 * usable by a clone the turn runs as its first step — a step that waits
 * for the worker and answers like a tool.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sandboxWorkspacesEnabled: jest.fn(() => true),
  sbEnvList: jest.fn(async () => ({ ok: true, val: [{ name: 'NPM_TOKEN' }] })),
  sbWorkspaceGet: jest.fn(),
  clientFailure: jest.fn(() => ({ status: 400, message: 'failed' })),
}));
jest.mock('./projects', () => ({ startProjectClone: jest.fn() }));
jest.mock('@/lib/chat/projects', () => ({ getProjectRow: jest.fn() }));
jest.mock('./tools', () => ({
  codeTools: jest.fn(() => [{ def: { name: 'code_ls' }, execute: jest.fn() }]),
}));
jest.mock('@/lib/sandbox/workspace-git', () => ({
  resolveWorkspaceGitCredential: jest.fn(async () => ({ authHeader: 'Basic x' })),
}));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => 'https://r.example' }));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { sbWorkspaceGet } from '@renkei/sandbox-client';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { startProjectClone } from './projects';
import { codeTools, type CodeToolBinding } from './tools';
import { CLONE_STEP_NAME, codeProjectContext } from './turn';

const get = sbWorkspaceGet as jest.MockedFunction<typeof sbWorkspaceGet>;
const clone = startProjectClone as jest.MockedFunction<typeof startProjectClone>;
const row = getProjectRow as jest.MockedFunction<typeof getProjectRow>;
const bound = () => (codeTools as jest.Mock).mock.calls[0]![0] as CodeToolBinding;
const db = {} as Kysely<DB>;

function project(workspaceId: string | null): ProjectRow {
  return {
    id: 'p1',
    tenantId: 't1',
    ownerSubject: 'alice',
    name: 'Billing',
    description: null,
    instructions: null,
    toolConfig: null,
    publishedToOrg: false,
    kind: 'code',
    repo: { provider: 'atlassian-bitbucket', fullName: 'acme/billing', branch: 'main' },
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ProjectRow;
}

const workspace = (
  status: 'cloning' | 'ready' | 'failed',
  extra: Record<string, unknown> = {}
) => ({
  id: 'ws-1',
  provider: 'atlassian-bitbucket',
  repoFullName: 'acme/billing',
  branch: 'main',
  status,
  error: null,
  sizeBytes: 4_300_000,
  createdAt: '',
  lastUsedAt: '',
  expiresAt: '',
  worker: null,
  ...extra,
});

beforeEach(() => jest.clearAllMocks());

describe('codeProjectContext', () => {
  it('offers the tools at once on a ready checkout, with no step', async () => {
    get.mockResolvedValue({ ok: true, val: workspace('ready') });
    const context = await codeProjectContext(db, project('ws-1'), { subject: 'alice' });
    expect(context?.prelude).toBeNull();
    expect(context?.prompt).toMatchObject({
      ready: true,
      clonedNow: false,
      envNames: ['NPM_TOKEN'],
    });
    expect(context?.tools.map((tool) => tool.def.name)).toEqual(['code_ls']);
    expect(clone).not.toHaveBeenCalled();
  });

  it('starts a clone when there is no checkout and hands the turn a step that waits for it', async () => {
    clone.mockResolvedValue({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready', { worker: 'sbx-7f3a' }) });
    const context = await codeProjectContext(db, project(null), { subject: 'alice' });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(context?.prompt).toMatchObject({ ready: true, clonedNow: true });
    expect(context?.prelude).toMatchObject({
      name: CLONE_STEP_NAME,
      input: { repository: 'acme/billing', branch: 'main' },
    });
    const result = await context!.prelude!.run();
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toMatch(
      /^Cloned acme\/billing @ main — 4\.1 MB on the sandbox \(worker sbx-7f3a\)/
    );
  }, 10_000);

  it('answers the step with an error when the clone fails', async () => {
    get.mockResolvedValueOnce({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: undefined, status: 404 },
    });
    clone.mockResolvedValue({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({
      ok: true,
      val: workspace('failed', { error: 'repository not found' }),
    });
    const context = await codeProjectContext(db, project('ws-old'), { subject: 'alice' });
    const result = await context!.prelude!.run();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('The clone failed: repository not found');
  }, 10_000);

  it('hands the tools a way back: a checkout lost mid-turn is cloned again and waited for', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    const context = await codeProjectContext(db, project('ws-1'), { subject: 'alice' });
    expect(context?.tools).toHaveLength(1);
    // The row still names the lost checkout: nothing newer to adopt.
    row.mockResolvedValue(project('ws-1'));
    clone.mockResolvedValue({ ok: true, val: workspace('cloning', { id: 'ws-2' }) });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready', { id: 'ws-2' }) });
    const recovered = await bound().recover!('ws-1');
    expect(clone).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({ ok: true, workspaceId: 'ws-2', how: 'cloned' });
  }, 10_000);

  it('adopts a newer clone another chat already made instead of cloning again', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    await codeProjectContext(db, project('ws-1'), { subject: 'alice' });
    row.mockResolvedValue(project('ws-9'));
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready', { id: 'ws-9' }) });
    const recovered = await bound().recover!('ws-1');
    expect(clone).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({ ok: true, workspaceId: 'ws-9', how: 'adopted' });
  });

  it('says why when the checkout cannot come back', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    await codeProjectContext(db, project('ws-1'), { subject: 'alice' });
    row.mockResolvedValue(project('ws-1'));
    clone.mockResolvedValue({
      ok: false,
      status: 502,
      message: 'Could not reach the sandbox service.',
    });
    const recovered = await bound().recover!('ws-1');
    expect(recovered).toEqual({ ok: false, message: 'Could not reach the sandbox service.' });
  });

  it('resumes waiting on a clone an earlier turn started', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    const context = await codeProjectContext(db, project('ws-1'), { subject: 'alice' });
    expect(clone).not.toHaveBeenCalled();
    expect(context?.prelude?.input).toMatchObject({ resumed: true });
    expect(context?.prompt.clonedNow).toBe(false);
  });
});
