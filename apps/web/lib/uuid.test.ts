/**
 * The uuid URL hygiene the proxy and the query seams rely on. The trailing
 * period case is the production one: a pasted URL that picked up sentence
 * punctuation from an autolinker, which Postgres met with a 22P02 → 500.
 */

import { isUuid, hasMalformedUuidSegment } from './uuid';

describe('isUuid', () => {
  it('accepts a canonical uuid in either case', () => {
    expect(isUuid('fb38968e-2dde-4c84-a1de-e78cc30a54a9')).toBe(true);
    expect(isUuid('FB38968E-2DDE-4C84-A1DE-E78CC30A54A9')).toBe(true);
  });

  it('rejects glued-on punctuation and other malformations', () => {
    expect(isUuid('fb38968e-2dde-4c84-a1de-e78cc30a54a9.')).toBe(false);
    expect(isUuid('fb38968e-2dde-4c84-a1de-e78cc30a54a9)')).toBe(false);
    expect(isUuid('fb38968e')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

describe('hasMalformedUuidSegment', () => {
  it('flags a uuid-keyed API path whose id carries trailing punctuation', () => {
    expect(hasMalformedUuidSegment('/api/mcp/fb38968e-2dde-4c84-a1de-e78cc30a54a9./mcp')).toBe(
      true
    );
    expect(hasMalformedUuidSegment('/api/tenant/garbage/agents')).toBe(true);
    expect(hasMalformedUuidSegment('/api/upload/nope')).toBe(true);
  });

  it('passes well-formed ids and unrelated paths through', () => {
    expect(hasMalformedUuidSegment('/api/mcp/fb38968e-2dde-4c84-a1de-e78cc30a54a9/mcp')).toBe(
      false
    );
    expect(
      hasMalformedUuidSegment('/api/webhooks/microsoft/fb38968e-2dde-4c84-a1de-e78cc30a54a9/acct-1')
    ).toBe(false);
    expect(hasMalformedUuidSegment('/api/health')).toBe(false);
    expect(hasMalformedUuidSegment('/nems-org/agents/whatever')).toBe(false);
  });
});
