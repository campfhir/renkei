/**
 * The verifier's contract: ownership encoded in the refId is the whole ACL —
 * the owner is granted, everyone else and everything malformed is denied,
 * and the comparison is case- and whitespace-insensitive on the user side.
 */

import { createMicrosoftAccessVerifier } from './verifier';
import { microsoftRefId } from './refs';

function ref(upn: string, id: string) {
  return { provider: 'microsoft', refId: microsoftRefId(upn, 'msg', id) };
}

describe('createMicrosoftAccessVerifier', () => {
  it('allows the owner, denies everyone else', async () => {
    const verifier = createMicrosoftAccessVerifier();

    const result = await verifier.verifyAccess('sam@contoso.com', [
      ref('sam@contoso.com', 'm1'),
      ref('sam@contoso.com', 'm2'),
      ref('lee@contoso.com', 'm3'),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.map((r) => r.refId)).toEqual([
        'sam@contoso.com/msg/m1',
        'sam@contoso.com/msg/m2',
      ]);
    }
  });

  it('matches case-insensitively and trims the requesting user', async () => {
    const verifier = createMicrosoftAccessVerifier();

    const result = await verifier.verifyAccess('  SAM@Contoso.COM ', [
      ref('sam@contoso.com', 'm1'),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toHaveLength(1);
  });

  it('denies malformed refs that name no owner', async () => {
    const verifier = createMicrosoftAccessVerifier();

    const result = await verifier.verifyAccess('sam@contoso.com', [
      { provider: 'microsoft', refId: 'no-owner-part' },
      { provider: 'microsoft', refId: '/msg/m1' },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual([]);
  });

  it('never calls the network — the check is pure', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const verifier = createMicrosoftAccessVerifier();

    await verifier.verifyAccess('sam@contoso.com', [ref('sam@contoso.com', 'm1')]);

    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
