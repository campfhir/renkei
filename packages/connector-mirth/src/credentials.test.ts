import { parseMirthCredentials } from './credentials';

describe('parseMirthCredentials', () => {
  it('accepts a username and password, trimming the name', () => {
    expect(parseMirthCredentials({ username: ' alice ', password: 's3cret' })).toEqual({
      username: 'alice',
      password: 's3cret',
    });
  });

  it('refuses partial or non-object input', () => {
    expect(parseMirthCredentials({ username: 'alice' })).toBeNull();
    expect(parseMirthCredentials({ password: 'x' })).toBeNull();
    expect(parseMirthCredentials({ username: '', password: 'x' })).toBeNull();
    expect(parseMirthCredentials('alice:x')).toBeNull();
    expect(parseMirthCredentials(null)).toBeNull();
  });
});
