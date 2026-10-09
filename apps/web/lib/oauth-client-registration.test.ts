import { readRegistration } from './oauth-client-registration';

describe('reading a dynamic client registration', () => {
  it('fills the defaults and tidies the name', () => {
    const result = readRegistration({
      client_name: '  Claude \n Code  ',
      redirect_uris: ['http://localhost:3000/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(result).toEqual({
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:3000/callback'],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('refuses a redirect URI the policy refuses, naming which one', () => {
    const result = readRegistration({
      redirect_uris: ['https://ok.example/cb', 'http://attacker.example/cb'],
    });
    expect(result).toMatchObject({ error: 'invalid_redirect_uri' });
    expect('problem' in result && result.problem).toMatch(/redirect_uris\[1\] must use https/);
  });

  it('refuses a missing, empty or oversized list', () => {
    expect(readRegistration({})).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(readRegistration({ redirect_uris: [] })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
    expect(
      readRegistration({
        redirect_uris: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`),
      })
    ).toMatchObject({ problem: expect.stringMatching(/at most 10/) });
    expect(readRegistration('nope')).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('bounds the rest of the metadata', () => {
    const uris = ['https://example.com/cb'];
    expect(readRegistration({ redirect_uris: uris, client_name: 7 })).toMatchObject({
      problem: 'client_name must be a string',
    });
    const long = readRegistration({ redirect_uris: uris, client_name: 'x'.repeat(500) });
    expect('client_name' in long && long.client_name?.length).toBe(200);
    expect(readRegistration({ redirect_uris: uris, response_types: ['token'] })).toMatchObject({
      error: 'invalid_client_metadata',
    });
    expect(readRegistration({ redirect_uris: uris, grant_types: ['implicit'] })).toMatchObject({
      error: 'invalid_client_metadata',
    });
    expect(
      readRegistration({ redirect_uris: uris, grant_types: ['authorization_code'] })
    ).toMatchObject({ grant_types: ['authorization_code'] });
  });
});
