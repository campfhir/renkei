/**
 * The pure parsing/classification helpers directly, and the GitHub
 * handler's full flow (matching → re-fetch → act → record) against a
 * stubbed db and stubbed host access/merge, mirroring
 * agent-run-failed.test.ts's stubDb pattern.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('./repo-access', () => ({
  resolveGitHubSubjectAccess: jest.fn(),
  resolveBitbucketSubjectAccess: jest.fn(),
}));
jest.mock('./repo-host-lite', () => ({
  getGitHubWorkflowRunConclusion: jest.fn(),
  mergeGitHubPullRequest: jest.fn(),
  getBitbucketCommitStatusConclusion: jest.fn(),
  mergeBitbucketPullRequest: jest.fn(),
}));
jest.mock('./chat-note', () => ({ insertChatNote: jest.fn() }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createGitHubPrPipelineHandler,
  isTerminal,
  parseGitHubWorkflowRun,
  parseBitbucketRepoFullName,
} from './pr-pipeline-events';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { resolveGitHubSubjectAccess: mockResolveGitHub } = jest.requireMock<{
  resolveGitHubSubjectAccess: jest.Mock;
}>('./repo-access');
const { getGitHubWorkflowRunConclusion: mockConclusion, mergeGitHubPullRequest: mockMerge } =
  jest.requireMock<{ getGitHubWorkflowRunConclusion: jest.Mock; mergeGitHubPullRequest: jest.Mock }>(
    './repo-host-lite'
  );
const { insertChatNote: mockInsertChatNote } = jest.requireMock<{ insertChatNote: jest.Mock }>(
  './chat-note'
);

describe('isTerminal', () => {
  it('is true for success and failure, false for anything mid-flight or unrecognized', () => {
    expect(isTerminal('success')).toBe(true);
    expect(isTerminal('failure')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('other')).toBe(false);
  });
});

describe('parseGitHubWorkflowRun', () => {
  it('reads the repo, run id and attached PR numbers from a completed run', () => {
    expect(
      parseGitHubWorkflowRun({
        action: 'completed',
        repository: { full_name: 'acme/site' },
        workflow_run: { id: 999, pull_requests: [{ number: 42 }, { number: 7 }] },
      })
    ).toEqual({ repoFullName: 'acme/site', runId: '999', prNumbers: [42, 7] });
  });

  it('is null for a run that is not yet completed — nothing to act on', () => {
    expect(
      parseGitHubWorkflowRun({
        action: 'requested',
        repository: { full_name: 'acme/site' },
        workflow_run: { id: 999 },
      })
    ).toBeNull();
  });

  it('is null without a repository full_name or a run id', () => {
    expect(parseGitHubWorkflowRun({ action: 'completed', workflow_run: { id: 999 } })).toBeNull();
    expect(
      parseGitHubWorkflowRun({ action: 'completed', repository: { full_name: 'acme/site' } })
    ).toBeNull();
  });
});

describe('parseBitbucketRepoFullName', () => {
  it('reads the repository full_name', () => {
    expect(parseBitbucketRepoFullName({ repository: { full_name: 'acme/site' } })).toBe('acme/site');
  });

  it('is null without one', () => {
    expect(parseBitbucketRepoFullName({})).toBeNull();
  });
});

const TENANT_ID = 'tenant-1';

function workflowRunEvent(prNumbers: number[]): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: TENANT_ID,
    source: 'github',
    type: 'workflow_run',
    attempts: 1,
    payload: {
      action: 'completed',
      repository: { full_name: 'acme/site' },
      workflow_run: { id: 999, pull_requests: prNumbers.map((number) => ({ number })) },
    },
  };
}

interface FakeDb {
  subscriptions: unknown[];
  pipelineEvents: unknown[];
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
}

function stubDb(fake: FakeDb): void {
  const selectBuilder = (table: string): unknown => ({
    select: () => selectBuilder(table),
    where: () => selectBuilder(table),
    execute: async () => (table === 'pr_subscriptions' ? fake.subscriptions : []),
    executeTakeFirst: async () =>
      table === 'pr_pipeline_events' ? fake.pipelineEvents[0] : undefined,
  });
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: (table: string) => selectBuilder(table),
      insertInto: (table: string) => ({
        values: (values: Record<string, unknown>) => {
          fake.inserted.push({ table, ...values });
          return { execute: async () => undefined };
        },
      }),
      updateTable: (table: string) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            where: () => ({
              where: () => ({
                where: () => ({
                  execute: async () => {
                    fake.updated.push({ table, ...values });
                  },
                }),
              }),
            }),
          }),
          execute: async () => {
            fake.updated.push({ table, ...values });
          },
        }),
      }),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createGitHubPrPipelineHandler', () => {
  it('skips a run with no attached pull requests', async () => {
    const fake: FakeDb = { subscriptions: [], pipelineEvents: [], inserted: [], updated: [] };
    stubDb(fake);
    const resolution = await createGitHubPrPipelineHandler()(workflowRunEvent([]));
    expect(resolution).toBe('skipped');
    expect(mockConclusion).not.toHaveBeenCalled();
  });

  it('skips when no active subscription matches the PR', async () => {
    const fake: FakeDb = { subscriptions: [], pipelineEvents: [], inserted: [], updated: [] };
    stubDb(fake);
    const resolution = await createGitHubPrPipelineHandler()(workflowRunEvent([42]));
    expect(resolution).toBe('skipped');
    expect(mockResolveGitHub).not.toHaveBeenCalled();
  });

  it('merges the PR when the subscribed pipeline is green and auto_merge is on', async () => {
    const fake: FakeDb = {
      subscriptions: [
        {
          id: 'sub-1',
          chat_id: null,
          subscriber_subject: 'alice@example.com',
          auto_fix: false,
          auto_merge: true,
          repo_full_name: 'acme/site',
          pr_number: 42,
        },
      ],
      pipelineEvents: [],
      inserted: [],
      updated: [],
    };
    stubDb(fake);
    mockResolveGitHub.mockResolvedValue({ accessToken: 'tok', login: 'alice' });
    mockConclusion.mockResolvedValue('success');
    mockMerge.mockResolvedValue({ ok: true, url: 'https://github.com/acme/site/pull/42' });

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockMerge).toHaveBeenCalledWith('tok', { fullName: 'acme/site' }, 42);
    const recorded = fake.inserted.find((row) => row.table === 'pr_pipeline_events');
    expect(recorded).toMatchObject({
      subscription_id: 'sub-1',
      provider_run_id: '999',
      conclusion: 'success',
      action_taken: 'merged',
    });
  });

  it('posts a chat note, not a merge, when the subscribed pipeline fails and auto_fix is on', async () => {
    const fake: FakeDb = {
      subscriptions: [
        {
          id: 'sub-2',
          chat_id: 'chat-1',
          subscriber_subject: 'bob@example.com',
          auto_fix: true,
          auto_merge: false,
          repo_full_name: 'acme/site',
          pr_number: 42,
        },
      ],
      pipelineEvents: [],
      inserted: [],
      updated: [],
    };
    stubDb(fake);
    mockResolveGitHub.mockResolvedValue({ accessToken: 'tok', login: 'bob' });
    mockConclusion.mockResolvedValue('failure');

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockInsertChatNote).toHaveBeenCalledWith(
      TENANT_ID,
      'chat-1',
      expect.stringContaining('#42')
    );
    expect(mockMerge).not.toHaveBeenCalled();
    const recorded = fake.inserted.find((row) => row.table === 'pr_pipeline_events');
    expect(recorded).toMatchObject({ conclusion: 'failure', action_taken: 'fix_started' });
  });

  it('does nothing beyond recording when the pipeline is still running', async () => {
    const fake: FakeDb = {
      subscriptions: [
        {
          id: 'sub-3',
          chat_id: 'chat-1',
          subscriber_subject: 'carol@example.com',
          auto_fix: true,
          auto_merge: true,
          repo_full_name: 'acme/site',
          pr_number: 42,
        },
      ],
      pipelineEvents: [],
      inserted: [],
      updated: [],
    };
    stubDb(fake);
    mockResolveGitHub.mockResolvedValue({ accessToken: 'tok', login: 'carol' });
    mockConclusion.mockResolvedValue('running');

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockInsertChatNote).not.toHaveBeenCalled();
    const recorded = fake.inserted.find((row) => row.table === 'pr_pipeline_events');
    expect(recorded).toMatchObject({ conclusion: 'running', action_taken: null });
  });
});
