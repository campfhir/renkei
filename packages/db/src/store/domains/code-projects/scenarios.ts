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

const PR = { ann: uid(1201), bob: uid(1202), annOld: uid(1203) };
const prKey = {
  provider: 'github',
  repoFullName: 'acme/beta',
  prNumber: 7,
  subscriberSubject: ANN,
};
const subscription = (id: string, extra: Record<string, unknown>) => ({
  id,
  project_id: PROJECT.annCode,
  provider: 'github',
  repo_full_name: 'acme/beta',
  pr_number: 7,
  subscriber_subject: ANN,
  created_at: at(1),
  updated_at: at(1),
  ...extra,
});
const prFixture = {
  ...chatWorld(),
  pr_subscriptions: [
    subscription(PR.ann, { chat_id: CHAT.annCode, auto_fix: true }),
    subscription(PR.bob, { subscriber_subject: BOB, auto_merge: true }),
    subscription(PR.annOld, { pr_number: 8, status: 'canceled', watch_pipelines: false }),
  ],
  pr_pipeline_events: [
    {
      id: uid(1302),
      subscription_id: PR.ann,
      provider_run_id: 'r2',
      conclusion: 'failure',
      observed_at: at(5),
    },
    {
      id: uid(1301),
      subscription_id: PR.ann,
      provider_run_id: 'r1',
      conclusion: 'success',
      action_taken: 'merged',
      observed_at: at(5),
    },
    {
      id: uid(1303),
      subscription_id: PR.ann,
      provider_run_id: 'r0',
      conclusion: 'failure',
      observed_at: at(4),
    },
  ],
};

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
  {
    method: 'codeProjects.noteLanguageGap',
    name: 'first opening inserts, later ones count up and move the sample',
    fixture,
    run: async (store) => {
      const gap = { extension: '.zig', language: 'zig', reason: 'no_server' };
      await store.codeProjects.noteLanguageGap({ ...gap, samplePath: 'a.zig' });
      await store.codeProjects.noteLanguageGap({ ...gap, samplePath: 'b/c.zig' });
      await store.codeProjects.noteLanguageGap({
        ...gap,
        reason: 'not_installed',
        samplePath: 'd.zig',
      });
      return (await store.codeProjects.listLanguageGaps()).map((row) => ({
        ...row,
        firstSeenAt: undefined,
        lastSeenAt: row.lastSeenAt.getTime() >= row.firstSeenAt.getTime(),
      }));
    },
  },
  {
    method: 'codeProjects.listLanguageGaps',
    name: 'most opened first, ties by extension, language, reason',
    fixture: {
      code_language_gaps: [
        {
          extension: '.b',
          language: 'b',
          reason: 'no_server',
          open_count: 2,
          first_seen_at: at(1),
          last_seen_at: at(2),
        },
        {
          extension: '.a',
          language: 'z',
          reason: 'no_server',
          open_count: 2,
          first_seen_at: at(1),
          last_seen_at: at(3),
        },
        {
          extension: '.a',
          language: 'a',
          reason: 'not_installed',
          open_count: 2,
          sample_path: 'x.a',
          first_seen_at: at(1),
          last_seen_at: at(4),
        },
        {
          extension: '.c',
          language: 'c',
          reason: 'no_server',
          open_count: 9,
          first_seen_at: at(1),
          last_seen_at: at(5),
        },
      ],
    },
    run: async (store) => [await store.codeProjects.listLanguageGaps()],
  },
  {
    method: 'codeProjects.getActivePrSubscription',
    name: "the subscriber's own active row only",
    fixture: prFixture,
    run: async (store) => [
      await store.codeProjects.getActivePrSubscription(prKey),
      await store.codeProjects.getActivePrSubscription({ ...prKey, subscriberSubject: BOB }),
      await store.codeProjects.getActivePrSubscription({ ...prKey, prNumber: 8 }),
      await store.codeProjects.getActivePrSubscription({ ...prKey, repoFullName: 'acme/other' }),
    ],
  },
  {
    method: 'codeProjects.latestPrPipelineEvent',
    name: 'newest outcome, ties by id',
    fixture: prFixture,
    run: async (store) => [
      await store.codeProjects.latestPrPipelineEvent(PR.ann),
      await store.codeProjects.latestPrPipelineEvent(PR.bob),
      await store.codeProjects.latestPrPipelineEvent(uid(999)),
    ],
  },
  {
    method: 'codeProjects.savePrSubscription',
    name: 'insert, then replace and reactivate',
    fixture: prFixture,
    run: async (store) => {
      const settings = {
        projectId: PROJECT.annCode,
        chatId: CHAT.annCode,
        watchPipelines: true,
        autoFix: true,
        autoMerge: false,
      };
      await store.codeProjects.savePrSubscription({ ...prKey, prNumber: 9, ...settings });
      await store.codeProjects.savePrSubscription({
        ...prKey,
        prNumber: 8,
        ...settings,
        chatId: null,
        autoFix: false,
        autoMerge: true,
      });
      const strip = (row: { id: string } | null) => row && { ...row, id: undefined };
      return [
        strip(await store.codeProjects.getActivePrSubscription({ ...prKey, prNumber: 9 })),
        await store.codeProjects.getActivePrSubscription({ ...prKey, prNumber: 8 }),
      ];
    },
  },
  {
    method: 'codeProjects.cancelPrSubscription',
    name: "the subscriber's own only",
    fixture: prFixture,
    run: async (store) => {
      await store.codeProjects.cancelPrSubscription(prKey);
      await store.codeProjects.cancelPrSubscription({ ...prKey, prNumber: 404 });
      return [
        await store.codeProjects.getActivePrSubscription(prKey),
        await store.codeProjects.getActivePrSubscription({ ...prKey, subscriberSubject: BOB }),
      ];
    },
  },
  {
    method: 'codeProjects.listPipelineSubscriptions',
    name: 'active pipeline watchers of a repository, one pull request when named',
    fixture: {
      ...prFixture,
      pr_subscriptions: [
        ...prFixture.pr_subscriptions,
        subscription(uid(1204), { pr_number: 3, subscriber_subject: BOB }),
        subscription(uid(1205), {
          pr_number: 7,
          subscriber_subject: 'carol',
          watch_pipelines: false,
        }),
        subscription(uid(1206), { repo_full_name: 'acme/gamma', subscriber_subject: 'dan' }),
        subscription(uid(1207), { provider: 'atlassian-bitbucket', subscriber_subject: 'erin' }),
      ],
    },
    run: async (store) => [
      await store.codeProjects.listPipelineSubscriptions('github', 'acme/beta'),
      await store.codeProjects.listPipelineSubscriptions('github', 'acme/beta', 7),
      await store.codeProjects.listPipelineSubscriptions('github', 'acme/beta', 8),
      await store.codeProjects.listPipelineSubscriptions('atlassian-bitbucket', 'acme/beta'),
      await store.codeProjects.listPipelineSubscriptions('github', 'acme/none'),
    ],
  },
  {
    method: 'codeProjects.hasPrPipelineEvent',
    name: "that subscription's run only",
    fixture: prFixture,
    run: async (store) => [
      await store.codeProjects.hasPrPipelineEvent(PR.ann, 'r1'),
      await store.codeProjects.hasPrPipelineEvent(PR.ann, 'r9'),
      await store.codeProjects.hasPrPipelineEvent(PR.bob, 'r1'),
      await store.codeProjects.hasPrPipelineEvent(uid(999), 'r1'),
    ],
  },
  {
    method: 'codeProjects.recordPrPipelineEvent',
    name: 'recorded for that subscription; readable as seen and as its latest',
    fixture: prFixture,
    run: async (store) => {
      await store.codeProjects.recordPrPipelineEvent({
        subscriptionId: PR.bob,
        providerRunId: 'run-77',
        conclusion: 'pending',
        rawPayload: { workflow_run: { id: 77 } },
        actionTaken: null,
      });
      const latest = await store.codeProjects.latestPrPipelineEvent(PR.bob);
      return {
        seen: await store.codeProjects.hasPrPipelineEvent(PR.bob, 'run-77'),
        elsewhere: await store.codeProjects.hasPrPipelineEvent(PR.ann, 'run-77'),
        latest: latest && { conclusion: latest.conclusion, actionTaken: latest.actionTaken },
      };
    },
  },
];
