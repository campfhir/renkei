import { notificationInAppPath, notificationTarget } from './targets';

const row = (over: Partial<Parameters<typeof notificationTarget>[0]> = {}) => ({
  kind: 'act',
  refUrl: null,
  agentId: null,
  runId: null,
  meta: null,
  ...over,
});

describe('notificationTarget', () => {
  it('opens the provider when the row links to one and the person wants that', () => {
    const jira = row({
      refUrl: 'https://acme.atlassian.net/browse/OPS-1',
      agentId: 'a',
      runId: 'r',
    });
    expect(notificationTarget(jira, true)).toEqual({
      url: 'https://acme.atlassian.net/browse/OPS-1',
      external: true,
    });
    expect(notificationTarget(jira, false)).toEqual({
      url: '/agents/a/runs/r',
      external: false,
    });
  });

  it('opens an in-app link in-app whatever the preference', () => {
    const chat = row({ kind: 'chat_permission', refUrl: '/chat/c1' });
    expect(notificationTarget(chat, true)).toEqual({
      url: '/chat/c1',
      external: false,
    });
  });
});

describe('notificationInAppPath', () => {
  it('follows the same precedence as a card on the notifications page', () => {
    expect(notificationInAppPath(row({ refUrl: '/chat/c1' }))).toBe('/chat/c1');
    expect(
      notificationInAppPath(
        row({ kind: 'batch_finished', meta: { batchId: 'b1', kind: 'ocr' } })
      )
    ).toBe('/batch-jobs/b1');
    expect(notificationInAppPath(row({ kind: 'agent_edited', agentId: 'a' }))).toBe(
      '/agents/a'
    );
    expect(
      notificationInAppPath(row({ kind: 'run_failed', agentId: 'a', runId: 'r' }))
    ).toBe('/agents/a/runs/r');
    expect(notificationInAppPath(row())).toBe('/notifications');
  });

  it('never follows a scheme-relative path', () => {
    expect(notificationInAppPath(row({ refUrl: '//evil.example/x' }))).toBe(
      '/notifications'
    );
  });
});
