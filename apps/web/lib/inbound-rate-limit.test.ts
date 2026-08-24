/**
 * The throttle guarding unauthenticated endpoints. What must hold: a burst
 * past the limit is REJECTED rather than delayed, the window really does
 * reopen, one client cannot spend another's budget, and — the point of
 * having two limits — forging the client address cannot buy more than the
 * global ceiling.
 */

import { checkInboundLimit, clientKey, resetInboundLimits } from './inbound-rate-limit';

const RULES = {
  perClient: { limit: 3, windowMs: 60_000 },
  global: { limit: 5, windowMs: 60_000 },
};

function requestFrom(ip: string): Request {
  return new Request('https://example.test/api/thing', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

beforeEach(() => resetInboundLimits());

describe('checkInboundLimit', () => {
  it('allows up to the per-client limit, then rejects with a retry hint', () => {
    const now = 1_000_000;
    const verdicts = Array.from({ length: 4 }, () =>
      checkInboundLimit('ep', requestFrom('1.2.3.4'), RULES, now)
    );
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false]);
    expect(verdicts[3].retryAfterSeconds).toBe(60);
  });

  it('reopens the window once it expires', () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i += 1) checkInboundLimit('ep', requestFrom('1.2.3.4'), RULES, now);
    expect(checkInboundLimit('ep', requestFrom('1.2.3.4'), RULES, now).allowed).toBe(false);
    // One millisecond past the window is a fresh budget.
    expect(checkInboundLimit('ep', requestFrom('1.2.3.4'), RULES, now + 60_001).allowed).toBe(true);
  });

  it('keeps one client from spending another client’s budget', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) checkInboundLimit('ep', requestFrom('1.1.1.1'), RULES, now);
    expect(checkInboundLimit('ep', requestFrom('1.1.1.1'), RULES, now).allowed).toBe(false);
    // A different caller is unaffected — until the global ceiling bites.
    expect(checkInboundLimit('ep', requestFrom('2.2.2.2'), RULES, now).allowed).toBe(true);
  });

  it('caps a spoofed-address flood at the global ceiling', () => {
    const now = 1_000_000;
    // A fresh forged IP every time defeats the per-client limit entirely...
    const verdicts = Array.from({ length: 8 }, (_, i) =>
      checkInboundLimit('ep', requestFrom(`10.0.0.${i}`), RULES, now)
    );
    // ...and still stops dead at the global limit of 5.
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(verdicts.slice(5).every((v) => !v.allowed)).toBe(true);
  });

  it('meters endpoints independently', () => {
    const now = 1_000_000;
    for (let i = 0; i < 6; i += 1) checkInboundLimit('ep', requestFrom('1.2.3.4'), RULES, now);
    expect(checkInboundLimit('other', requestFrom('1.2.3.4'), RULES, now).allowed).toBe(true);
  });
});

describe('clientKey', () => {
  it('takes the left-most forwarded address', () => {
    const request = new Request('https://example.test/', {
      headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' },
    });
    expect(clientKey(request)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientKey(new Request('https://e.test/', { headers: { 'x-real-ip': '9.9.9.9' } }))).toBe(
      '9.9.9.9'
    );
    // No headers at all: everyone shares one bucket rather than none.
    expect(clientKey(new Request('https://e.test/'))).toBe('unknown');
  });
});
