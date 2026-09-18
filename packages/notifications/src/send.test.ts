import { pushClickTarget } from './send';

const base = { tenantId: 't1', slug: 'acme' };

describe('pushClickTarget', () => {
  it('routes a click through the row when there is one, whatever the target', () => {
    const target = pushClickTarget({
      ...base,
      refUrl: 'https://acme.atlassian.net/browse/OPS-1',
      notificationId: 'n1',
      openInSourceApp: true,
    });
    expect(target.openUrl).toBe('/api/tenant/t1/notifications/n1/open');
    expect(target.external).toBe(true);
    expect(target.appUrl).toBe('/acme/notifications');
  });

  it('keeps the person in Renkei when they turned the source application off', () => {
    const target = pushClickTarget({
      ...base,
      refUrl: 'https://acme.atlassian.net/browse/OPS-1',
      notificationId: 'n1',
      openInSourceApp: false,
    });
    expect(target.external).toBe(false);
    expect(target.openUrl).toBe('/api/tenant/t1/notifications/n1/open');
  });

  it('opens an in-app link in-app, source application or not', () => {
    const target = pushClickTarget({
      ...base,
      refUrl: '/acme/chat/c1',
      appPath: '/acme/chat/c1',
      openInSourceApp: true,
    });
    expect(target).toEqual({
      appUrl: '/acme/chat/c1',
      openUrl: '/acme/chat/c1',
      external: false,
    });
  });

  it('falls back to the notifications page, and never to a scheme-relative path', () => {
    expect(pushClickTarget({ ...base, refUrl: null, openInSourceApp: true }).openUrl).toBe(
      '/acme/notifications'
    );
    expect(
      pushClickTarget({ ...base, refUrl: null, appPath: '//evil.example', openInSourceApp: true })
        .appUrl
    ).toBe('/acme/notifications');
  });

  it('goes straight to the provider for a push with no row behind it', () => {
    const target = pushClickTarget({
      ...base,
      refUrl: 'webexteams://im?space=abc',
      openInSourceApp: true,
    });
    expect(target.openUrl).toBe('webexteams://im?space=abc');
    expect(target.external).toBe(true);
  });
});
