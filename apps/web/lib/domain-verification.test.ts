import { verificationRecord, verifyDomainOwnership } from './domain-verification';

const TOKEN = 'a1b2c3d4e5f6';

function resolverWith(records: string[][]) {
  return jest.fn(async () => records);
}

describe('verifyDomainOwnership', () => {
  it('verifies when the TXT set carries our record', async () => {
    const resolve = resolverWith([['v=spf1 -all'], [verificationRecord(TOKEN)]]);
    await expect(verifyDomainOwnership('acme.com', TOKEN, resolve)).resolves.toEqual({
      verified: true,
    });
    expect(resolve).toHaveBeenCalledWith('acme.com');
  });

  it('joins a record split into character-string chunks', async () => {
    const record = verificationRecord(TOKEN);
    const resolve = resolverWith([[record.slice(0, 10), record.slice(10)]]);
    await expect(verifyDomainOwnership('acme.com', TOKEN, resolve)).resolves.toEqual({
      verified: true,
    });
  });

  it('reports a stale token apart from no record at all', async () => {
    await expect(
      verifyDomainOwnership('acme.com', TOKEN, resolverWith([[verificationRecord('other')]]))
    ).resolves.toEqual({ verified: false, reason: 'wrong-token' });
    await expect(
      verifyDomainOwnership('acme.com', TOKEN, resolverWith([['v=spf1 -all']]))
    ).resolves.toEqual({ verified: false, reason: 'no-record' });
  });

  it('treats a missing name or empty set as no record, other failures as retryable', async () => {
    const notFound = jest.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    });
    await expect(verifyDomainOwnership('acme.com', TOKEN, notFound)).resolves.toEqual({
      verified: false,
      reason: 'no-record',
    });
    const timeout = jest.fn(async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    });
    await expect(verifyDomainOwnership('acme.com', TOKEN, timeout)).resolves.toEqual({
      verified: false,
      reason: 'lookup-failed',
    });
  });

  it('does not accept a record that merely starts with ours', async () => {
    await expect(
      verifyDomainOwnership('acme.com', TOKEN, resolverWith([[`${verificationRecord(TOKEN)}zz`]]))
    ).resolves.toEqual({ verified: false, reason: 'wrong-token' });
  });
});
