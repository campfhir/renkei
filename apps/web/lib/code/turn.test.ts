/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The turn's view of a code project's checkout: usable at once, or made
 * usable by a clone the turn runs as its first step — a step that waits
 * for the worker and answers like a tool.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sandboxWorkspacesEnabled: jest.fn(async () => true),
  sandboxServicesEnabled: jest.fn(async () => false),
  sbEnvList: jest.fn(async () => ({ ok: true, val: [{ name: 'NPM_TOKEN' }] })),
  sbWorkspaceGet: jest.fn(),
  clientFailure: jest.fn(() => ({ status: 400, message: 'failed' })),
}));
jest.mock('./projects', () => ({ startProjectClone: jest.fn(), startChatWorktree: jest.fn() }));
jest.mock('@/lib/chat/store', () => ({ getChatRow: jest.fn() }));
jest.mock('@/lib/chat/projects', () => ({ getProjectRow: jest.fn() }));
jest.mock('./tools', () => ({
  codeTools: jest.fn(() => [{ def: { name: 'code_ls' }, execute: jest.fn() }]),
}));
jest.mock('@/lib/sandbox/workspace-git', () => ({
  resolveWorkspaceGitAccess: jest.fn(async () => ({
    gitProxy: {
      base: 'http://delegate:8096/git/t/bitbucket.org/',
      insteadOf: 'https://bitbucket.org/',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    username: 'alice',
  })),
}));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => 'https://r.example' }));
jest.mock('@/lib/chat/models', () => ({
  listChatModels: jest.fn(async () => [
    {
      id: 'm-fast',
      label: 'Fast',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      isDefault: false,
      supportsThinking: true,
      contextWindow: null,
    },
    {
      id: 'm-best',
      label: 'Best',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      isDefault: true,
      supportsThinking: true,
      contextWindow: null,
    },
  ]),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { sbWorkspaceGet } from '@renkei/sandbox-client';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { startChatWorktree, startProjectClone } from './projects';
import { getChatRow } from '@/lib/chat/store';
import { codeTools, type CodeToolBinding } from './tools';
import { CLONE_STEP_NAME, codeProjectContext } from './turn';

const get = sbWorkspaceGet as jest.MockedFunction<typeof sbWorkspaceGet>;
const clone = startProjectClone as jest.MockedFunction<typeof startProjectClone>;
const worktree = startChatWorktree as jest.MockedFunction<typeof startChatWorktree>;
const chatRow = getChatRow as jest.MockedFunction<typeof getChatRow>;
const row = getProjectRow as jest.MockedFunction<typeof getProjectRow>;
const bound = () => (codeTools as jest.Mock).mock.calls[0]![0] as CodeToolBinding;
const db = {} as Kysely<DB>;

function project(workspaceId: string | null): ProjectRow {
  return {
    id: 'p1',
    ownerSubject: 'alice',
    name: 'Billing',
    description: null,
    sealedInstructions: null,
    toolConfig: null,
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
  parentId: null,
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

const actor = (workspaceId: string | null = null) => ({
  subject: 'alice',
  chat: { id: 'c1234567-0000', workspaceId },
});
const treeOf = (extra: Record<string, unknown> = {}) =>
  workspace('ready', { id: 'wt-1', parentId: 'ws-1', branch: 'renkei/c1234567', ...extra });

describe('codeProjectContext', () => {
  it('binds a ready chat worktree at once, with no step', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    get.mockResolvedValueOnce({ ok: true, val: treeOf() });
    const context = await codeProjectContext(db, project('ws-1'), actor('wt-1'));
    expect(context?.prelude).toBeNull();
    expect(context?.prompt).toMatchObject({
      ready: true,
      clonedNow: false,
      branch: 'renkei/c1234567',
      envNames: ['NPM_TOKEN'],
    });
    expect(context?.tools.map((tool) => tool.def.name)).toEqual(['code_ls']);
    expect(clone).not.toHaveBeenCalled();
    expect(worktree).not.toHaveBeenCalled();
    expect(bound().workspaceId).toBe('wt-1');
    // The org's roster rides into the binding, for a sub-agent's model to be picked from.
    expect(bound().subagentModels).toHaveLength(2);
  });

  it('makes the chat its own worktree of the ready clone on its first turn', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: true, val: treeOf() });
    const context = await codeProjectContext(db, project('ws-1'), actor());
    expect(worktree).toHaveBeenCalledTimes(1);
    expect(worktree.mock.calls[0]![1]).toBe('c1234567-0000');
    expect(worktree.mock.calls[0]![2]).toMatchObject({ id: 'ws-1' });
    // The remote is fetched first, with the person's own grant.
    expect(worktree.mock.calls[0]![3]).toMatchObject({ insteadOf: 'https://bitbucket.org/' });
    expect(context?.prelude).toBeNull();
    expect(bound().workspaceId).toBe('wt-1');
  });

  it('gives a second chat a worktree of its own instead of the first chat’s', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    // The chat names a worktree of an older clone: not its own any more.
    get.mockResolvedValueOnce({ ok: true, val: treeOf({ parentId: 'ws-old' }) });
    worktree.mockResolvedValue({ ok: true, val: treeOf({ id: 'wt-2' }) });
    await codeProjectContext(db, project('ws-1'), actor('wt-1'));
    expect(worktree).toHaveBeenCalledTimes(1);
    expect(bound().workspaceId).toBe('wt-2');
  });

  it('starts a clone when there is no checkout and hands the turn a step that clones, then makes the worktree', async () => {
    clone.mockResolvedValue({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready', { worker: 'sbx-7f3a' }) });
    worktree.mockResolvedValue({ ok: true, val: treeOf() });
    const context = await codeProjectContext(db, project(null), actor());
    expect(clone).toHaveBeenCalledTimes(1);
    expect(worktree).not.toHaveBeenCalled();
    expect(context?.prompt).toMatchObject({ ready: true, clonedNow: true });
    expect(context?.prelude).toMatchObject({
      name: CLONE_STEP_NAME,
      input: { repository: 'acme/billing', branch: 'main' },
    });
    expect(bound().workspaceRef).toEqual({ id: 'ws-1' });
    const result = await context!.prelude!.run();
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toMatch(
      /^Cloned acme\/billing @ main — 4\.1 MB on the sandbox \(worker sbx-7f3a\)/
    );
    expect(result.content[0]!.text).toContain('its own worktree, on renkei/c1234567');
    // The tools now work in the worktree, not in the clone.
    expect(bound().workspaceRef).toEqual({ id: 'wt-1' });
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
    const context = await codeProjectContext(db, project('ws-old'), actor());
    const result = await context!.prelude!.run();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('The clone failed: repository not found');
    expect(worktree).not.toHaveBeenCalled();
  }, 10_000);

  it('answers the step with an error when the worktree cannot be made', async () => {
    clone.mockResolvedValue({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: false, status: 409, message: 'the branch is taken' });
    const context = await codeProjectContext(db, project(null), actor());
    const result = await context!.prelude!.run();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('worktree could not be made: the branch is taken');
  });

  it('says so, with no tools, when the worktree cannot be made for a ready clone', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: false, status: 409, message: 'the branch is taken' });
    const context = await codeProjectContext(db, project('ws-1'), actor());
    expect(context?.tools).toEqual([]);
    expect(context?.prompt).toMatchObject({ ready: false });
  });

  it('hands the tools a way back: a lost checkout is cloned again and the chat gets a worktree in it', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    get.mockResolvedValueOnce({ ok: true, val: treeOf() });
    const context = await codeProjectContext(db, project('ws-1'), actor('wt-1'));
    expect(context?.tools).toHaveLength(1);
    // The row still names the lost clone: nothing newer to adopt.
    row.mockResolvedValue(project('ws-1'));
    chatRow.mockResolvedValue({ id: 'c1234567-0000', workspaceId: 'wt-1' } as never);
    get.mockResolvedValueOnce({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: undefined, status: 404 },
    });
    clone.mockResolvedValue({ ok: true, val: workspace('cloning', { id: 'ws-2' }) });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready', { id: 'ws-2' }) });
    get.mockResolvedValueOnce({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: undefined, status: 404 },
    });
    worktree.mockResolvedValue({ ok: true, val: treeOf({ id: 'wt-2', parentId: 'ws-2' }) });
    const recovered = await bound().recover!('wt-1');
    expect(clone).toHaveBeenCalledTimes(1);
    expect(worktree.mock.calls[0]![2]).toMatchObject({ id: 'ws-2' });
    expect(recovered).toMatchObject({ ok: true, workspaceId: 'wt-2', how: 'cloned' });
  }, 10_000);

  it('adopts a newer clone another chat already made instead of cloning again', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    get.mockResolvedValueOnce({ ok: true, val: treeOf() });
    await codeProjectContext(db, project('ws-1'), actor('wt-1'));
    row.mockResolvedValue(project('ws-9'));
    chatRow.mockResolvedValue({ id: 'c1234567-0000', workspaceId: 'wt-1' } as never);
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready', { id: 'ws-9' }) });
    // The chat's recorded worktree hangs off the lost clone, so it gets a new one.
    get.mockResolvedValueOnce({ ok: true, val: treeOf() });
    worktree.mockResolvedValue({ ok: true, val: treeOf({ id: 'wt-9', parentId: 'ws-9' }) });
    const recovered = await bound().recover!('wt-1');
    expect(clone).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({ ok: true, workspaceId: 'wt-9', how: 'adopted' });
  });

  it('says why when the checkout cannot come back', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    get.mockResolvedValueOnce({ ok: true, val: treeOf() });
    await codeProjectContext(db, project('ws-1'), actor('wt-1'));
    row.mockResolvedValue(project('ws-1'));
    chatRow.mockResolvedValue({ id: 'c1234567-0000', workspaceId: 'wt-1' } as never);
    get.mockResolvedValueOnce({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: undefined, status: 404 },
    });
    clone.mockResolvedValue({
      ok: false,
      status: 502,
      message: 'Could not reach the sandbox service; it may be restarting. Try again in a moment.',
    });
    const recovered = await bound().recover!('wt-1');
    expect(recovered).toEqual({
      ok: false,
      message: 'Could not reach the sandbox service; it may be restarting. Try again in a moment.',
    });
  });

  it('resumes waiting on a clone an earlier turn started', async () => {
    get.mockResolvedValueOnce({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: true, val: treeOf() });
    const context = await codeProjectContext(db, project('ws-1'), actor());
    expect(clone).not.toHaveBeenCalled();
    expect(context?.prelude?.input).toMatchObject({ resumed: true });
    expect(context?.prompt.clonedNow).toBe(false);
  });
});
