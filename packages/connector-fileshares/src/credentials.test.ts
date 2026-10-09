import { parseShareCredentials } from './credentials';

describe('parseShareCredentials', () => {
  it('accepts each credential shape', () => {
    expect(
      parseShareCredentials({ protocol: 'smb', username: 'svc', password: 'pw', domain: 'CORP' })
    ).toEqual({ protocol: 'smb', username: 'svc', password: 'pw', domain: 'CORP' });
    expect(parseShareCredentials({ protocol: 'smb', username: 'svc', password: 'pw' })).toEqual({
      protocol: 'smb',
      username: 'svc',
      password: 'pw',
    });
    expect(parseShareCredentials({ protocol: 'sftp', username: 'svc', password: 'pw' })).toEqual({
      protocol: 'sftp',
      username: 'svc',
      password: 'pw',
    });
    expect(
      parseShareCredentials({
        protocol: 'sftp',
        username: 'svc',
        privateKey: 'PEM',
        passphrase: 'pp',
      })
    ).toEqual({ protocol: 'sftp', username: 'svc', privateKey: 'PEM', passphrase: 'pp' });
  });

  it('rejects a document missing required fields, an unknown protocol, and non-objects', () => {
    expect(parseShareCredentials({ protocol: 'smb', username: 'svc' })).toBeNull();
    expect(parseShareCredentials({ protocol: 'ftp', username: 'a', password: 'b' })).toBeNull();
    expect(parseShareCredentials('not json')).toBeNull();
    expect(parseShareCredentials(null)).toBeNull();
  });
});
