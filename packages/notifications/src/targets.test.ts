import { isExternalNotificationUrl, isWebUrl } from './targets';

describe('isExternalNotificationUrl', () => {
  it('treats a provider link as external, whatever its scheme', () => {
    expect(isExternalNotificationUrl('https://acme.atlassian.net/browse/OPS-1')).toBe(true);
    expect(isExternalNotificationUrl('webexteams://im?space=abc&message=def')).toBe(true);
  });

  it('treats a path on this origin, or nothing, as in-app', () => {
    expect(isExternalNotificationUrl('/acme/chat/123')).toBe(false);
    expect(isExternalNotificationUrl('/acme/notifications')).toBe(false);
    expect(isExternalNotificationUrl(null)).toBe(false);
    expect(isExternalNotificationUrl(undefined)).toBe(false);
    expect(isExternalNotificationUrl('')).toBe(false);
  });
});

describe('isWebUrl', () => {
  it('only says yes to http(s)', () => {
    expect(isWebUrl('https://acme.atlassian.net/browse/OPS-1')).toBe(true);
    expect(isWebUrl('http://localhost:3000/x')).toBe(true);
    expect(isWebUrl('webexteams://im?space=abc')).toBe(false);
  });
});
