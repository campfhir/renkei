/**
 * The payload parsers: server-side validation the UI preview merely
 * mirrors. The properties pinned are the ones that carry security weight —
 * Windows spellings normalize, traversal never survives, a partial
 * credential is an error rather than a guess, and delete exposure never
 * survives without write.
 */

import { parseConnectPayload, parseExposurePayload, parseSharePayload } from './parse';

const BASE = {
  name: 'Accounting',
  protocol: 'smb',
  host: 'files.corp.test',
  shareName: 'accounting',
};

describe('parseSharePayload', () => {
  it('accepts a minimal SMB share and applies the protocol case default', () => {
    const parsed = parseSharePayload(BASE);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.input.caseInsensitive).toBe(true);
    expect(parsed.input.rootPath).toBe('/');
    expect(parsed.input.port).toBeNull();
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

  it('bounds the port', () => {
    expect('error' in parseSharePayload({ ...BASE, port: 0 })).toBe(true);
    expect('error' in parseSharePayload({ ...BASE, port: 70000 })).toBe(true);
    const parsed = parseSharePayload({ ...BASE, port: 1445 });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.input.port).toBe(1445);
  });
});

describe('parseExposurePayload', () => {
  it('accepts the two levels and nothing else', () => {
    expect('error' in parseExposurePayload({ toolAccess: 'read' })).toBe(false);
    expect('error' in parseExposurePayload({ toolAccess: 'read_write' })).toBe(false);
    expect('error' in parseExposurePayload({ toolAccess: 'none' })).toBe(true);
    expect('error' in parseExposurePayload({})).toBe(true);
  });

  it('normalizes delete-without-write away instead of storing a lie', () => {
    const parsed = parseExposurePayload({ toolAccess: 'read', allowDelete: true });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.allowDelete).toBe(false);

    const withWrite = parseExposurePayload({ toolAccess: 'read_write', allowDelete: true });
    if ('error' in withWrite) throw new Error(withWrite.error);
    expect(withWrite.allowDelete).toBe(true);
  });
});

describe('parseConnectPayload', () => {
  it('treats a partial credential as an error, not a guess', () => {
    expect('error' in parseConnectPayload('smb', { toolAccess: 'read', username: 'me' })).toBe(
      true
    );
    expect('error' in parseConnectPayload('smb', { toolAccess: 'read', password: 'pw' })).toBe(
      true
    );
    const complete = parseConnectPayload('smb', {
      toolAccess: 'read',
      username: 'me',
      password: 'pw',
      domain: 'CORP',
    });
    if ('error' in complete) throw new Error(complete.error);
    expect(complete.credentials).toEqual({
      protocol: 'smb',
      username: 'me',
      password: 'pw',
      domain: 'CORP',
    });
  });

  it('builds an SFTP key credential when a private key is supplied', () => {
    const parsed = parseConnectPayload('sftp', {
      toolAccess: 'read_write',
      allowDelete: true,
      username: 'me',
      privateKey: 'PEM',
      passphrase: 'pp',
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.credentials).toEqual({
      protocol: 'sftp',
      username: 'me',
      privateKey: 'PEM',
      passphrase: 'pp',
    });
    expect(parsed.toolAccess).toBe('read_write');
    expect(parsed.allowDelete).toBe(true);
  });

  it('the credential protocol is the SHARE protocol, never caller-chosen', () => {
    const parsed = parseConnectPayload('sftp', {
      toolAccess: 'read',
      // A caller-supplied protocol field is simply ignored.
      protocol: 'smb',
      username: 'me',
      password: 'pw',
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.credentials.protocol).toBe('sftp');
  });
});
