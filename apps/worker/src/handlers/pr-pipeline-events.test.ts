/**
 * The pure parsing/classification helpers directly, and the GitHub
 * handler's full flow (matching → re-fetch → act → record) against a
 * stubbed db and stubbed host access/merge, mirroring
 * agent-run-failed.test.ts's stubDb pattern.
 */

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
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import {
  createGitHubPrPipelineHandler,
  isTerminal,
  parseGitHubWorkflowRun,
  parseBitbucketRepoFullName,
} from './pr-pipeline-events';
import type { ClaimedEvent } from '../queue';
import { authedFetch } from '@renkei/delegate-client';

/** A grant fetcher stand-in: the code under test only passes it through. */
const auth = authedFetch(async () => new Response(), 'github:tenant-1:alice');

const { resolveGitHubSubjectAccess: mockResolveGitHub } = jest.requireMock<{
  resolveGitHubSubjectAccess: jest.Mock;
}>('./repo-access');
const { getGitHubWorkflowRunConclusion: mockConclusion, mergeGitHubPullRequest: mockMerge } =
  jest.requireMock<{
    getGitHubWorkflowRunConclusion: jest.Mock;
    mergeGitHubPullRequest: jest.Mock;
  }>('./repo-host-lite');
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
    expect(parseBitbucketRepoFullName({ repository: { full_name: 'acme/site' } })).toBe(
      'acme/site'
    );
  });

  it('is null without one', () => {
    expect(parseBitbucketRepoFullName({})).toBeNull();
  });
});

function workflowRunEvent(prNumbers: number[]): ClaimedEvent {
  return {
    id: 'evt-1',
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

const PROJECT = '00000000-0000-4000-8000-000000000100';
const CHAT = '00000000-0000-4000-8000-000000000200';
const SUB = '00000000-0000-4000-8000-000000000001';

/** The memory store holding the subscriptions and the recorded outcomes. */
let store: MemoryDataStore;

interface Subscription {
  chat_id: string | null;
  subscriber_subject: string;
  auto_fix: boolean;
  auto_merge: boolean;
  pr_number: number;
  status?: string;
}

async function seedSubscription(subscription: Subscription): Promise<void> {
  await store.seed({
    chat_projects: [{ id: PROJECT, name: 'site', owner_subject: subscription.subscriber_subject }],
    chats: [{ id: CHAT, owner_subject: subscription.subscriber_subject }],
    pr_subscriptions: [
      {
        id: SUB,
        project_id: PROJECT,
        provider: 'github',
        repo_full_name: 'acme/site',
        watch_pipelines: true,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
        ...subscription,
      },
    ],
  });
}

/** What the handler recorded for the run, or null. */
async function recorded() {
  return store.codeProjects.latestPrPipelineEvent(SUB);
}

afterEach(() => {
  resetDataStore();
});

beforeEach(() => {
  jest.clearAllMocks();
  store = createMemoryDataStore();
  registerDataStore(store);
});

describe('createGitHubPrPipelineHandler', () => {
  it('skips a run with no attached pull requests', async () => {
    const resolution = await createGitHubPrPipelineHandler()(workflowRunEvent([]));
    expect(resolution).toBe('skipped');
    expect(mockConclusion).not.toHaveBeenCalled();
  });

  it('skips when no active subscription matches the PR', async () => {
    // A subscription on another pull request only.
    await seedSubscription({
      chat_id: null,
      subscriber_subject: 'alice@example.com',
      auto_fix: false,
      auto_merge: true,
      pr_number: 41,
    });
    const resolution = await createGitHubPrPipelineHandler()(workflowRunEvent([42]));
    expect(resolution).toBe('skipped');
    expect(mockResolveGitHub).not.toHaveBeenCalled();
  });

  it('merges the PR when the subscribed pipeline is green and auto_merge is on', async () => {
    await seedSubscription({
      chat_id: null,
      subscriber_subject: 'alice@example.com',
      auto_fix: false,
      auto_merge: true,
      pr_number: 42,
    });
    mockResolveGitHub.mockResolvedValue({ auth, login: 'alice' });
    mockConclusion.mockResolvedValue('success');
    mockMerge.mockResolvedValue({ ok: true, url: 'https://github.com/acme/site/pull/42' });

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockMerge).toHaveBeenCalledWith(auth, { fullName: 'acme/site' }, 42);
    expect(await recorded()).toMatchObject({ conclusion: 'success', actionTaken: 'merged' });
    expect(await store.codeProjects.hasPrPipelineEvent(SUB, '999')).toBe(true);
  });

  it('is a no-op on a redelivered run already recorded', async () => {
    await seedSubscription({
      chat_id: null,
      subscriber_subject: 'alice@example.com',
      auto_fix: false,
      auto_merge: true,
      pr_number: 42,
    });
    await store.seed({
      pr_pipeline_events: [
        {
          subscription_id: SUB,
          id: '00000000-0000-4000-8000-000000000999',
          provider_run_id: '999',
          conclusion: 'success',
          action_taken: 'merged',
          raw_payload: {},
          observed_at: new Date(),
        },
      ],
    });
    mockResolveGitHub.mockResolvedValue({ auth, login: 'alice' });
    mockConclusion.mockResolvedValue('success');

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockMerge).not.toHaveBeenCalled();
  });

  it('posts a chat note, not a merge, when the subscribed pipeline fails and auto_fix is on', async () => {
    await seedSubscription({
      chat_id: CHAT,
      subscriber_subject: 'bob@example.com',
      auto_fix: true,
      auto_merge: false,
      pr_number: 42,
    });
    mockResolveGitHub.mockResolvedValue({ auth, login: 'bob' });
    mockConclusion.mockResolvedValue('failure');

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockInsertChatNote).toHaveBeenCalledWith(CHAT, expect.stringContaining('#42'));
    expect(mockMerge).not.toHaveBeenCalled();
    expect(await recorded()).toMatchObject({ conclusion: 'failure', actionTaken: 'fix_started' });
  });

  it('does nothing beyond recording when the pipeline is still running', async () => {
    await seedSubscription({
      chat_id: CHAT,
      subscriber_subject: 'carol@example.com',
      auto_fix: true,
      auto_merge: true,
      pr_number: 42,
    });
    mockResolveGitHub.mockResolvedValue({ auth, login: 'carol' });
    mockConclusion.mockResolvedValue('running');

    await createGitHubPrPipelineHandler()(workflowRunEvent([42]));

    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockInsertChatNote).not.toHaveBeenCalled();
    expect(await recorded()).toMatchObject({ conclusion: 'running', actionTaken: null });
  });
});
