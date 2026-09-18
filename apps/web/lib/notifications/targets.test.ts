import { notificationInAppPath, notificationTarget } from './targets';

const row = (over: Partial<Parameters<typeof notificationTarget>[1]> = {}) => ({
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
    expect(notificationTarget('acme', jira, true)).toEqual({
      url: 'https://acme.atlassian.net/browse/OPS-1',
      external: true,
    });
    expect(notificationTarget('acme', jira, false)).toEqual({
      url: '/acme/agents/a/runs/r',
      external: false,
    });
  });

  it('opens an in-app link in-app whatever the preference', () => {
    const chat = row({ kind: 'chat_permission', refUrl: '/acme/chat/c1' });
    expect(notificationTarget('acme', chat, true)).toEqual({
      url: '/acme/chat/c1',
      external: false,
    });
  });
});

describe('notificationInAppPath', () => {
  it('follows the same precedence as a card on the notifications page', () => {
    expect(notificationInAppPath('acme', row({ refUrl: '/acme/chat/c1' }))).toBe('/acme/chat/c1');
    expect(
      notificationInAppPath(
        'acme',
        row({ kind: 'batch_finished', meta: { batchId: 'b1', kind: 'ocr' } })
      )
    ).toBe('/acme/batch-jobs/b1');
    expect(notificationInAppPath('acme', row({ kind: 'agent_edited', agentId: 'a' }))).toBe(
      '/acme/agents/a'
    );
    expect(
      notificationInAppPath('acme', row({ kind: 'run_failed', agentId: 'a', runId: 'r' }))
    ).toBe('/acme/agents/a/runs/r');
    expect(notificationInAppPath('acme', row())).toBe('/acme/notifications');
  });

  it('never follows a scheme-relative path', () => {
    expect(notificationInAppPath('acme', row({ refUrl: '//evil.example/x' }))).toBe(
      '/acme/notifications'
    );
  });
});
