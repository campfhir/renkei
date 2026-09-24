import { combineFilters, filterClause, parseBaseUrl, validApiPath } from './api';

describe('parseBaseUrl', () => {
  it('accepts https and strips a trailing /api and trailing slash', () => {
    expect(parseBaseUrl('https://admp.corp.example:8080/api/', false)).toBe(
      'https://admp.corp.example:8080'
    );
    expect(parseBaseUrl('https://admp.corp.example:8080', false)).toBe(
      'https://admp.corp.example:8080'
    );
  });

  it('refuses http unless allowInsecureHttp is set', () => {
    expect(parseBaseUrl('http://admp.corp.example:8080', false)).toBeNull();
    expect(parseBaseUrl('http://admp.corp.example:8080', true)).toBe(
      'http://admp.corp.example:8080'
    );
  });

  it('refuses credentials, query strings and fragments in the URL', () => {
    expect(parseBaseUrl('https://user:pass@admp.corp.example', false)).toBeNull();
    expect(parseBaseUrl('https://admp.corp.example?x=1', false)).toBeNull();
    expect(parseBaseUrl('https://admp.corp.example#frag', false)).toBeNull();
  });

  it('refuses empty or unparseable input', () => {
    expect(parseBaseUrl('', false)).toBeNull();
    expect(parseBaseUrl('   ', false)).toBeNull();
    expect(parseBaseUrl('not a url', false)).toBeNull();
    expect(parseBaseUrl(42, false)).toBeNull();
  });
});

describe('validApiPath', () => {
  it('accepts absolute /api/ routes and the legacy /RestAPI/ routes', () => {
    expect(validApiPath('/api/v1/user/unlockUserAccount')).toBe(true);
    expect(validApiPath('/api/v2/users')).toBe(true);
    expect(validApiPath('/RestAPI/UnlockUser')).toBe(true);
    expect(validApiPath('/RestAPI/ResetPwd')).toBe(true);
  });

  it('refuses path traversal, a second URL, query strings and non-/api/non-/RestAPI paths', () => {
    expect(validApiPath('/api/v2/../v1/user/unlockUserAccount')).toBe(false);
    expect(validApiPath('/api/v2/users?filter=x')).toBe(false);
    expect(validApiPath('https://evil.example/api/v2/users')).toBe(false);
    expect(validApiPath('//evil.example/api/v2/users')).toBe(false);
    expect(validApiPath('/other/v2/users')).toBe(false);
    expect(validApiPath('api/v2/users')).toBe(false);
    expect(validApiPath('/RestAPI/../v2/users')).toBe(false);
    expect(validApiPath('RestAPI/UnlockUser')).toBe(false);
  });
});

describe('filterClause / combineFilters', () => {
  it('wraps the value in its own unquoted parens, stripping any literal parens, and wraps the whole clause', () => {
    expect(filterClause('SAM_ACCOUNT_NAME', 'eq', 'jdoe')).toBe('(SAM_ACCOUNT_NAME eq (jdoe))');
    expect(filterClause('LAST_NAME', 'co', 'O(Brien)')).toBe('(LAST_NAME co (OBrien))');
  });

  it('joins already-wrapped clauses without adding another layer of parens', () => {
    expect(combineFilters(['(FIRST_NAME eq (A))'])).toBe('(FIRST_NAME eq (A))');
    expect(combineFilters(['(FIRST_NAME eq (A))', '(LAST_NAME eq (B))'], 'and')).toBe(
      '(FIRST_NAME eq (A)) and (LAST_NAME eq (B))'
    );
    expect(combineFilters(['(FIRST_NAME eq (A))', '(FIRST_NAME eq (B))'], 'or')).toBe(
      '(FIRST_NAME eq (A)) or (FIRST_NAME eq (B))'
    );
  });

  it('drops empty clauses and returns empty for none', () => {
    expect(combineFilters(['', '  '])).toBe('');
    expect(combineFilters(['', '(FIRST_NAME eq (A))'])).toBe('(FIRST_NAME eq (A))');
  });
});
