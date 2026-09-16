import { isDestructiveRequest, parseBaseUrl, unwrapList, unwrapMap, validApiPath } from './api';

describe('parseBaseUrl', () => {
  it('keeps origin and path prefix, dropping trailing slashes and a pasted /api', () => {
    expect(parseBaseUrl('https://mirth.example:8443/', false)).toBe('https://mirth.example:8443');
    expect(parseBaseUrl('https://mirth.example:8443/api', false)).toBe(
      'https://mirth.example:8443'
    );
    expect(parseBaseUrl('https://gw.example/mirth/api/', false)).toBe('https://gw.example/mirth');
  });

  it('refuses plaintext unless the operator allowed it', () => {
    expect(parseBaseUrl('http://mirth.example:8080', false)).toBeNull();
    expect(parseBaseUrl('http://mirth.example:8080', true)).toBe('http://mirth.example:8080');
  });

  it('refuses credentials, queries, fragments and garbage', () => {
    expect(parseBaseUrl('https://admin:admin@mirth.example', false)).toBeNull();
    expect(parseBaseUrl('https://mirth.example/?x=1', false)).toBeNull();
    expect(parseBaseUrl('https://mirth.example/#top', false)).toBeNull();
    expect(parseBaseUrl('mirth.example', false)).toBeNull();
    expect(parseBaseUrl('', false)).toBeNull();
    expect(parseBaseUrl(42, false)).toBeNull();
  });
});

describe('validApiPath', () => {
  it('accepts absolute API routes', () => {
    expect(validApiPath('/channels')).toBe(true);
    expect(validApiPath('/channels/abc-123/messages/_reprocess')).toBe(true);
    expect(validApiPath('/server/version')).toBe(true);
  });

  it('refuses relative, climbing, second-URL, query and control-character paths', () => {
    expect(validApiPath('channels')).toBe(false);
    expect(validApiPath('/channels/../users')).toBe(false);
    expect(validApiPath('//evil.example/x')).toBe(false);
    expect(validApiPath('/x?y=1')).toBe(false);
    expect(validApiPath('/x#y')).toBe(false);
    expect(validApiPath('/x y')).toBe(false);
    expect(validApiPath('/x\ny')).toBe(false);
    expect(validApiPath('/https://evil.example')).toBe(false);
  });
});

describe('isDestructiveRequest', () => {
  it('treats every DELETE as destructive and no GET', () => {
    expect(isDestructiveRequest('DELETE', '/channels/abc')).toBe(true);
    expect(isDestructiveRequest('DELETE', '/alerts/abc')).toBe(true);
    expect(isDestructiveRequest('GET', '/server/configuration')).toBe(false);
  });

  it('flags the removing, purging and replacing writes', () => {
    expect(isDestructiveRequest('POST', '/channels/abc/messages/_remove')).toBe(true);
    expect(isDestructiveRequest('POST', '/channels/_removeChannels')).toBe(true);
    expect(isDestructiveRequest('PUT', '/server/configuration')).toBe(true);
    expect(isDestructiveRequest('POST', '/channels/_clearAllStatistics')).toBe(true);
    expect(isDestructiveRequest('POST', '/extensions/_uninstall')).toBe(true);
  });

  it('leaves reversible operations as ordinary writes', () => {
    expect(isDestructiveRequest('POST', '/channels/abc/_deploy')).toBe(false);
    expect(isDestructiveRequest('POST', '/channels/_stop')).toBe(false);
    expect(isDestructiveRequest('POST', '/channels/abc/messages')).toBe(false);
    expect(isDestructiveRequest('PUT', '/channels/abc')).toBe(false);
    expect(isDestructiveRequest('PUT', '/server/configurationMap')).toBe(false);
  });
});

describe('unwrapList', () => {
  it('flattens XStream list envelopes, single elements included', () => {
    expect(unwrapList({ list: { channel: [{ id: 'a' }, { id: 'b' }] } })).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(unwrapList({ list: { channel: { id: 'a' } } })).toEqual([{ id: 'a' }]);
    expect(unwrapList({ set: { string: ['x', 'y'] } })).toEqual(['x', 'y']);
  });

  it('answers empty for empty envelopes and non-lists', () => {
    expect(unwrapList({ list: '' })).toEqual([]);
    expect(unwrapList({ list: null })).toEqual([]);
    expect(unwrapList('nope')).toEqual([]);
    expect(unwrapList({ a: 1, b: 2 })).toEqual([]);
  });

  it('passes bare arrays and bare element maps through', () => {
    expect(unwrapList([1, 2])).toEqual([1, 2]);
    expect(unwrapList({ dashboardStatus: [{ name: 'x' }] })).toEqual([{ name: 'x' }]);
  });
});

describe('unwrapMap', () => {
  it('reads homogeneous string maps', () => {
    expect(
      unwrapMap({
        map: { entry: [{ string: ['id-1', 'Channel One'] }, { string: ['id-2', 'Two'] }] },
      })
    ).toEqual({ 'id-1': 'Channel One', 'id-2': 'Two' });
    expect(unwrapMap({ map: { entry: { string: ['only', 'one'] } } })).toEqual({ only: 'one' });
  });

  it('reads mixed-type maps', () => {
    expect(
      unwrapMap({
        map: {
          entry: [
            { string: 'k', int: 3 },
            { string: 'flag', boolean: true },
          ],
        },
      })
    ).toEqual({ k: 3, flag: true });
  });

  it('answers empty for empty envelopes and non-maps', () => {
    expect(unwrapMap({ map: '' })).toEqual({});
    expect(unwrapMap(null)).toEqual({});
    expect(unwrapMap([])).toEqual({});
  });
});
