import { parseAdManagerCredentials } from './credentials';

describe('parseAdManagerCredentials', () => {
  it('accepts an authtoken, trimming it', () => {
    expect(parseAdManagerCredentials({ authToken: ' abc123 ' })).toEqual({
      authToken: 'abc123',
    });
  });

  it('refuses empty or non-object input', () => {
    expect(parseAdManagerCredentials({ authToken: '' })).toBeNull();
    expect(parseAdManagerCredentials({ authToken: '   ' })).toBeNull();
    expect(parseAdManagerCredentials({})).toBeNull();
    expect(parseAdManagerCredentials('abc123')).toBeNull();
    expect(parseAdManagerCredentials(null)).toBeNull();
  });
});
