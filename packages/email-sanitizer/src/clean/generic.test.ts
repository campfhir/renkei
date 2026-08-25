/**
 * Link-rewriting gateways, unwrapped.
 *
 * Mail and calendar invites are mostly links, and every gateway an org puts
 * in front of them replaces a readable URL with a few hundred characters of
 * opaque token. Left in, that is what gets embedded — so these are not
 * cosmetic fixes, they decide whether a chunk carries meaning or noise.
 */

import { defluffUrls } from './generic';

describe('defluffUrls — every gateway, including nested ones', () => {
  it('unwraps safelinks wrapping urldefense, which is what NEMS mail actually contains', () => {
    // Taken from a real indexed calendar invite: two gateways in sequence.
    // Peeling one layer leaves the other, so this is the case that proves
    // the loop rather than a single unwrap.
    const nested =
      'https://nam11.safelinks.protection.outlook.com/?url=https%3A%2F%2Furldefense.com%2Fv3%2F__https%3A%2F%2Fdialin.teams.cloud.microsoft%2Fusp%2Fpstnconferencing__%3B!!Cqmyxg!d862OIt7i4XM1c7AB&data=05%7C02';
    const cleaned = defluffUrls(`Dial in: ${nested}`);
    expect(cleaned).toContain('dialin.teams.cloud.microsoft');
    expect(cleaned).not.toContain('safelinks');
    expect(cleaned).not.toContain('urldefense');
  });

  it('unwraps Proofpoint v3 on its own', () => {
    const wrapped = 'https://urldefense.com/v3/__https://example.com/docs__;!!abc$';
    expect(defluffUrls(wrapped)).toContain('example.com/docs');
  });

  it('unwraps Proofpoint v2, which encodes % as - and / as _', () => {
    const wrapped =
      'https://urldefense.proofpoint.com/v2/url?u=https-3A__example.com_a_b&d=DwMFaQ&c=xyz';
    expect(defluffUrls(wrapped)).toContain('example.com/a/b');
  });

  it('unwraps Barracuda link protection', () => {
    const wrapped =
      'https://linkprotect.cudasvc.com/url?a=https%3A%2F%2Fexample.com%2Freport&c=E,1,abc';
    expect(defluffUrls(wrapped)).toContain('example.com/report');
  });

  it('reduces an irreversible Mimecast token to the domain it names', () => {
    // The original cannot be recovered — it lives in their service — but a
    // domain is still enormously more useful than an opaque token.
    const wrapped = 'https://protect-eu.mimecast.com/s/AbC123XyZ?domain=example.com';
    const cleaned = defluffUrls(wrapped);
    expect(cleaned).toContain('example.com');
    expect(cleaned).not.toContain('AbC123XyZ');
  });

  it('leaves an ordinary URL alone', () => {
    const plain = 'https://example.com/page?id=7';
    expect(defluffUrls(plain)).toBe(plain);
  });
});
