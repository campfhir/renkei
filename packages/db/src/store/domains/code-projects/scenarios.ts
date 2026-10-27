import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CHAT, PROJECT, at, chatWorld, uid } from '../chats/fixtures';

const PREFIX = 'code-project:';
const SUBJECT = `${PREFIX}${PROJECT.annCode}`;

function workspace(id: string, status: string, branch: string) {
  return {
    id,
    subject: SUBJECT,
    provider: 'github',
    repo_full_name: 'acme/beta',
    branch,
    status,
    storage_key: `k/${id}`,
    expires_at: at(100),
  };
}

function request(n: number, subject: string, minute: number, status = 'pending') {
  return {
    id: uid(1200 + n),
    subject,
    requested_by: ANN,
    requested_bytes: String(n * 1_000_000_000),
    reason: `r${n}`,
    status,
    created_at: at(minute),
    ...(status === 'pending' ? {} : { decided_by: BOB, decided_at: at(minute + 1) }),
  };
}

function grant(account: string, minute: number, granted: string[] | null) {
  return {
    provider: 'github',
    provider_account_id: account,
    subject: ANN,
    client_id: 'c',
    display_name: account,
    encrypted_access_token: 'x',
    encrypted_refresh_token: 'y',
    expires_at: at(100),
    requested_scopes: ['repo'],
    granted_scopes: granted,
    updated_at: at(minute),
  };
}

const fixture = {
  ...chatWorld(),
  sandbox_workspaces: [
    workspace(uid(901), 'ready', 'main'),
    workspace(uid(902), 'ready', 'renkei/abc'),
    workspace(uid(903), 'cloning', 'main'),
    workspace(uid(904), 'ready', ''),
  ],
  chat_turns: [
    {
      chat_id: CHAT.annCode,
      status: 'complete',
      input_tokens: 10,
      output_tokens: 3,
      started_at: at(1),
    },
    {
      chat_id: CHAT.annCode,
      status: 'complete',
      input_tokens: 5,
      output_tokens: 4,
      started_at: at(2),
    },
    {
      chat_id: CHAT.annA,
      status: 'complete',
      input_tokens: 99,
      output_tokens: 99,
      started_at: at(2),
    },
  ],
  sandbox_size_requests: [
    request(1, SUBJECT, 1, 'denied'),
    request(2, SUBJECT, 3, 'approved'),
    request(3, `${PREFIX}${uid(999)}`, 2),
    request(4, `${PREFIX}${PROJECT.annChat}`, 4, 'denied'),
  ],
  provider_grants: [grant('acct-b', 5, ['repo']), grant('acct-a', 5, null), grant('acct-c', 1, [])],
};

const omitNow = <T extends { decidedAt: Date | null } | null>(row: T) =>
  row && { ...row, decidedAt: row.decidedAt ? 'set' : null };

export const codeProjectScenarios: Scenario<DataStore>[] = [
  {
    method: 'codeProjects.workspaceBranches',
    name: 'ready checkouts with a branch only',
    fixture,
    run: async (store) => [
      await store.codeProjects.workspaceBranches([uid(904), uid(903), uid(902), uid(901), uid(1)]),
      await store.codeProjects.workspaceBranches([]),
    ],
  },
  {
    method: 'codeProjects.usageByChat',
    name: "summed per chat of the project's",
    fixture,
    run: async (store) => [
      await store.codeProjects.usageByChat(PROJECT.annCode),
      await store.codeProjects.usageByChat(PROJECT.annChat),
      await store.codeProjects.usageByChat(PROJECT.bobChat),
    ],
  },
  {
    method: 'codeProjects.latestSizeRequest',
    name: 'newest whatever its state',
    fixture,
    run: async (store) => [
      await store.codeProjects.latestSizeRequest(SUBJECT),
      await store.codeProjects.latestSizeRequest('none'),
    ],
  },
  {
    method: 'codeProjects.approvedSizes',
    name: 'approved only, smallest first, one subject',
    fixture: {
      ...fixture,
      sandbox_size_requests: [
        request(7, `${PREFIX}${uid(77)}`, 1, 'approved'),
        request(3, `${PREFIX}${uid(77)}`, 2, 'approved'),
        request(9, `${PREFIX}${uid(77)}`, 3, 'denied'),
        request(5, `${PREFIX}${uid(78)}`, 4, 'approved'),
      ],
    },
    run: async (store) => [
      await store.codeProjects.approvedSizes(`${PREFIX}${uid(77)}`),
      await store.codeProjects.approvedSizes('none'),
    ],
  },
  {
    method: 'codeProjects.createSizeRequest',
    name: 'one pending per subject',
    fixture,
    run: async (store) => {
      const input = { subject: SUBJECT, requestedBy: BOB, requestedBytes: 5e9, reason: 'big' };
      const first = await store.codeProjects.createSizeRequest(input);
      const second = await store.codeProjects.createSizeRequest(input);
      const elsewhere = await store.codeProjects.createSizeRequest({
        ...input,
        subject: `${PREFIX}${uid(999)}`,
      });
      const shape = (row: typeof first) =>
        row && [row.subject, row.requestedBy, row.requestedBytes, row.reason, row.status];
      return [shape(first), second, shape(elsewhere)];
    },
  },
  {
    method: 'codeProjects.listSizeRequests',
    name: 'pending first, newest, with project names',
    fixture,
    run: async (store) => [
      await store.codeProjects.listSizeRequests(PREFIX, 10),
      (await store.codeProjects.listSizeRequests(PREFIX, 2)).map((r) => r.id),
    ],
  },
  {
    method: 'codeProjects.decideSizeRequest',
    name: 'pending only; approving may change bytes',
    fixture,
    run: async (store) => [
      omitNow(
        await store.codeProjects.decideSizeRequest({
          id: uid(1203),
          status: 'approved',
          decidedBy: BOB,
          note: 'ok',
          approvedBytes: 7e9,
        })
      ),
      await store.codeProjects.decideSizeRequest({
        id: uid(1203),
        status: 'denied',
        decidedBy: BOB,
        note: null,
      }),
      await store.codeProjects.decideSizeRequest({
        id: uid(1201),
        status: 'approved',
        decidedBy: BOB,
        note: null,
      }),
    ],
  },
  {
    method: 'codeProjects.providerGrantScopes',
    name: 'newest connection, ties by account',
    fixture,
    run: async (store) => [
      await store.codeProjects.providerGrantScopes(ANN, 'github'),
      await store.codeProjects.providerGrantScopes(ANN, 'atlassian-bitbucket'),
      await store.codeProjects.providerGrantScopes(BOB, 'github'),
    ],
  },
];
