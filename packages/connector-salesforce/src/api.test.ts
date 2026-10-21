import {
  dataPath,
  parseIdentityUrl,
  parseMyDomain,
  salesforceAccountId,
  sameOrg,
  SALESFORCE_API_VERSION,
} from './api';
import { isSalesforceId, keyPrefix, sameId, to18 } from './ids';

describe('API version', () => {
  it('pins every path to v68.0', () => {
    expect(SALESFORCE_API_VERSION).toBe('68.0');
    expect(dataPath('/sobjects')).toBe('/services/data/v68.0/sobjects');
    expect(dataPath('query?q=x')).toBe('/services/data/v68.0/query?q=x');
  });
});

describe('parseMyDomain', () => {
  it('normalizes what an admin pastes to the org origin', () => {
    expect(parseMyDomain('acme.my.salesforce.com')).toEqual({
      ok: true,
      origin: 'https://acme.my.salesforce.com',
      host: 'acme.my.salesforce.com',
    });
    expect(parseMyDomain(' https://Acme.my.salesforce.com/lightning/page/home ')).toMatchObject({
      ok: true,
      origin: 'https://acme.my.salesforce.com',
    });
    expect(parseMyDomain('acme--uat.sandbox.my.salesforce.com')).toMatchObject({ ok: true });
    expect(parseMyDomain('dod.my.salesforce.mil')).toMatchObject({ ok: true });
  });

  it('refuses anything that is not an org My Domain over https', () => {
    expect(parseMyDomain('')).toEqual({ ok: false, error: 'NOT_A_URL' });
    expect(parseMyDomain('http://acme.my.salesforce.com')).toEqual({
      ok: false,
      error: 'NOT_HTTPS',
    });
    expect(parseMyDomain('login.salesforce.com')).toEqual({ ok: false, error: 'NOT_MY_DOMAIN' });
    expect(parseMyDomain('my.salesforce.com')).toEqual({ ok: false, error: 'NOT_MY_DOMAIN' });
    expect(parseMyDomain('acme.my.salesforce.com.evil.example')).toEqual({
      ok: false,
      error: 'NOT_MY_DOMAIN',
    });
    expect(parseMyDomain('acme.my.salesforce.com:8443')).toEqual({
      ok: false,
      error: 'NOT_MY_DOMAIN',
    });
  });

  it('matches a token instance_url to the configured org only', () => {
    expect(sameOrg('https://acme.my.salesforce.com', 'https://acme.my.salesforce.com')).toBe(true);
    expect(sameOrg('https://other.my.salesforce.com', 'https://acme.my.salesforce.com')).toBe(
      false
    );
    expect(sameOrg('not a url', 'https://acme.my.salesforce.com')).toBe(false);
  });
});

describe('identity', () => {
  it('reads org and user ids from the identity URL', () => {
    expect(
      parseIdentityUrl('https://login.salesforce.com/id/00D000000000062EAA/005000000000001AAA')
    ).toEqual({ orgId: '00D000000000062EAA', userId: '005000000000001AAA' });
    expect(parseIdentityUrl('https://login.salesforce.com/services/oauth2/userinfo')).toBeNull();
    expect(salesforceAccountId('00Dx', '005y')).toBe('00Dx/005y');
  });
});

describe('ids', () => {
  it('converts 15 to 18 characters with the checksum', () => {
    expect(to18('00D000000000062')).toBe('00D000000000062EAA');
    expect(to18('00D000000000062EAA')).toBe('00D000000000062EAA');
    expect(to18('not-an-id')).toBe('not-an-id');
  });

  it('recognizes ids and compares them across lengths', () => {
    expect(isSalesforceId('001000000000001')).toBe(true);
    expect(isSalesforceId('001000000000001AAA')).toBe(true);
    expect(isSalesforceId('0010000000000')).toBe(false);
    expect(sameId('00D000000000062', '00D000000000062EAA')).toBe(true);
    expect(keyPrefix('001000000000001AAA')).toBe('001');
  });
});
