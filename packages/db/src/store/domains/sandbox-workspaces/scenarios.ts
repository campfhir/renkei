import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function row(
  n: number,
  subject: string,
  minute: number,
  options: { parent?: number; expires?: number; status?: string } = {}
) {
  return {
    id: id(n),
    subject,
    provider: 'github',
    repo_full_name: `acme/repo-${n}`,
    branch: 'main',
    storage_key: `ws-${n}`,
    parent_id: options.parent ? id(options.parent) : null,
    status: options.status ?? 'ready',
    error: null,
    size_bytes: String(n * 100),
    created_at: at(minute),
    last_used_at: at(minute),
    expires_at: at(options.expires ?? 100 + n),
  };
}

const fixture = {
  sandbox_workspaces: [
    row(1, 'ann', 1),
    row(2, 'ann', 2, { parent: 1 }),
    row(3, 'ann', 2, { parent: 1 }),
    row(4, 'ann', 4, { status: 'cloning' }),
    row(5, 'bob', 5),
    row(6, 'bob', 6, { parent: 1 }),
  ],
};

export const sandboxWorkspaceScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxWorkspaces.insert',
    name: 'a new row, defaults filled, read back',
    fixture,
    run: async (store) => {
      const inserted = await store.sandboxWorkspaces.insert({
        id: id(9),
        subject: 'ann',
        provider: 'gitlab',
        repoFullName: 'acme/new',
        branch: 'dev',
        storageKey: 'ws-9',
        parentId: id(1),
        status: 'ready',
        expiresAt: at(300),
      });
      const { createdAt: _c, lastUsedAt: _l, ...rest } = inserted;
      return [
        rest,
        await store.sandboxWorkspaces.count('ann', true),
        await store.sandboxWorkspaces.get('bob', id(9)),
      ];
    },
  },
  {
    method: 'sandboxWorkspaces.list',
    name: 'newest first, ties by id, the subject’s only',
    fixture,
    run: async (store) => [
      await store.sandboxWorkspaces.list('ann'),
      await store.sandboxWorkspaces.list('nobody'),
    ],
  },
  {
    method: 'sandboxWorkspaces.count',
    name: 'clones and worktrees apart',
    fixture,
    run: async (store) => [
      await store.sandboxWorkspaces.count('ann', false),
      await store.sandboxWorkspaces.count('ann', true),
      await store.sandboxWorkspaces.count('bob', true),
      await store.sandboxWorkspaces.count('nobody', false),
    ],
  },
  {
    method: 'sandboxWorkspaces.get',
    name: 'the subject’s own only',
    fixture,
    run: async (store) => [
      await store.sandboxWorkspaces.get('ann', id(4)),
      await store.sandboxWorkspaces.get('bob', id(4)),
      await store.sandboxWorkspaces.get('ann', id(99)),
    ],
  },
  {
    method: 'sandboxWorkspaces.setStatus',
    name: 'status and error replaced, size and branch only when given',
    fixture,
    run: async (store) => {
      await store.sandboxWorkspaces.setStatus(id(4), 'failed', { error: 'clone failed' });
      const failed = await store.sandboxWorkspaces.get('ann', id(4));
      await store.sandboxWorkspaces.setStatus(id(4), 'ready', {
        error: null,
        sizeBytes: 1234,
        branch: 'feature',
      });
      return [failed, await store.sandboxWorkspaces.get('ann', id(4))];
    },
  },
  {
    method: 'sandboxWorkspaces.listWorktrees',
    name: 'the subject’s worktrees of one base, oldest first, ties by id',
    fixture,
    run: async (store) => [
      (await store.sandboxWorkspaces.listWorktrees('ann', id(1))).map((w) => w.id),
      (await store.sandboxWorkspaces.listWorktrees('bob', id(1))).map((w) => w.id),
      await store.sandboxWorkspaces.listWorktrees('ann', id(4)),
    ],
  },
  {
    method: 'sandboxWorkspaces.touch',
    name: 'extends the base clone too; a base touches only itself',
    fixture,
    run: async (store) => {
      await store.sandboxWorkspaces.touch(id(2), {
        lastUsedAt: at(50),
        expiresAt: at(900),
        branch: 'wt',
      });
      await store.sandboxWorkspaces.touch(id(5), {
        lastUsedAt: at(60),
        expiresAt: at(950),
        sizeBytes: 77,
      });
      return [await store.sandboxWorkspaces.list('ann'), await store.sandboxWorkspaces.list('bob')];
    },
  },
  {
    method: 'sandboxWorkspaces.delete',
    name: 'returns the row, the subject’s only',
    fixture,
    run: async (store) => [
      await store.sandboxWorkspaces.delete('bob', id(1)),
      await store.sandboxWorkspaces.delete('ann', id(1)),
      (await store.sandboxWorkspaces.list('ann')).map((w) => w.id),
    ],
  },
  {
    method: 'sandboxWorkspaces.listExpired',
    name: 'soonest expiring first, bounded',
    fixture,
    run: async (store) => [
      (await store.sandboxWorkspaces.listExpired(at(104), 10)).map((w) => w.id),
      (await store.sandboxWorkspaces.listExpired(at(200), 2)).map((w) => w.id),
      await store.sandboxWorkspaces.listExpired(at(0), 10),
    ],
  },
  {
    method: 'sandboxWorkspaces.deleteById',
    name: 'whoever holds it',
    fixture,
    run: async (store) => {
      await store.sandboxWorkspaces.deleteById(id(5));
      await store.sandboxWorkspaces.deleteById(id(99));
      return (await store.sandboxWorkspaces.list('bob')).map((w) => w.id);
    },
  },
  {
    method: 'sandboxWorkspaces.getById',
    name: 'across subjects',
    fixture,
    run: async (store) => [
      await store.sandboxWorkspaces.getById(id(6)),
      await store.sandboxWorkspaces.getById(id(99)),
    ],
  },
  {
    method: 'sandboxWorkspaces.listWorktreesOf',
    name: 'across subjects, oldest first, ties by id',
    fixture,
    run: async (store) => [
      (await store.sandboxWorkspaces.listWorktreesOf(id(1))).map((w) => w.id),
      await store.sandboxWorkspaces.listWorktreesOf(id(5)),
    ],
  },
];
