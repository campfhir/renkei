/**
 * The admin payload parsers: server-side validation the UI preview merely
 * mirrors. The properties pinned are the ones that carry security weight —
 * Windows spellings normalize, traversal never survives, and a partial
 * credential is an error rather than a guess.
 */

import { parseGrantPayload, parseRulePayload, parseSharePayload } from './parse';

const BASE = {
  name: 'Accounting',
  protocol: 'smb',
  host: 'files.corp.test',
  shareName: 'accounting',
  maxAccess: 'read',
};

describe('parseSharePayload', () => {
  it('accepts a minimal SMB share and applies the protocol case default', () => {
    const parsed = parseSharePayload(BASE);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.input.caseInsensitive).toBe(true);
    expect(parsed.input.rootPath).toBe('/');
    expect(parsed.input.port).toBeNull();
    expect(parsed.credentials).toBeUndefined();
  });

  it('defaults SFTP to case-sensitive', () => {
    const parsed = parseSharePayload({ ...BASE, protocol: 'sftp', shareName: undefined });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.input.caseInsensitive).toBe(false);
  });

  it('requires shareName for SMB only', () => {
    expect('error' in parseSharePayload({ ...BASE, shareName: '' })).toBe(true);
    const sftp = parseSharePayload({ ...BASE, protocol: 'sftp', shareName: '' });
    expect('error' in sftp).toBe(false);
  });

  it('translates Windows root paths and rejects traversal', () => {
    const unc = parseSharePayload({ ...BASE, rootPath: '\\\\files\\accounting\\2024' });
    if ('error' in unc) throw new Error(unc.error);
    expect(unc.input.rootPath).toBe('/2024');

    expect('error' in parseSharePayload({ ...BASE, rootPath: '/a/../..' })).toBe(true);
  });

  it('treats a partial credential as an error, not a guess', () => {
    expect('error' in parseSharePayload({ ...BASE, username: 'svc' })).toBe(true);
    expect('error' in parseSharePayload({ ...BASE, password: 'pw' })).toBe(true);
    const complete = parseSharePayload({ ...BASE, username: 'svc', password: 'pw' });
    if ('error' in complete) throw new Error(complete.error);
    expect(complete.credentials).toEqual({ protocol: 'smb', username: 'svc', password: 'pw' });
  });

  it('builds an SFTP key credential when a private key is supplied', () => {
    const parsed = parseSharePayload({
      ...BASE,
      protocol: 'sftp',
      shareName: undefined,
      username: 'svc',
      privateKey: 'PEM',
      passphrase: 'pp',
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.credentials).toEqual({
      protocol: 'sftp',
      username: 'svc',
      privateKey: 'PEM',
      passphrase: 'pp',
    });
  });

  it('bounds the port', () => {
    expect('error' in parseSharePayload({ ...BASE, port: 0 })).toBe(true);
    expect('error' in parseSharePayload({ ...BASE, port: 70000 })).toBe(true);
    const parsed = parseSharePayload({ ...BASE, port: 1445 });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.input.port).toBe(1445);
  });
});

describe('parseGrantPayload', () => {
  it('accepts the three levels and nothing else', () => {
    expect('error' in parseGrantPayload({ subject: 's', defaultAccess: 'none' })).toBe(false);
    expect('error' in parseGrantPayload({ subject: 's', defaultAccess: 'write' })).toBe(true);
    expect('error' in parseGrantPayload({ defaultAccess: 'read' })).toBe(true);
  });
});

describe('parseRulePayload', () => {
  it('normalizes Windows rule paths and maps empty subject to the share layer', () => {
    const parsed = parseRulePayload({ path: 'reports\\q4', access: 'none' });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.path).toBe('/reports/q4');
    expect(parsed.subject).toBeNull();
  });

  it('rejects traversal in rule paths', () => {
    expect('error' in parseRulePayload({ path: '/a/../b', access: 'read' })).toBe(true);
  });
});
