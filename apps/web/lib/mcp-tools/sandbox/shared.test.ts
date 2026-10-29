import type { MCPToolContext } from '../common';
import { targetOf } from './shared';

const base: MCPToolContext = {
  accountId: '',
  siteUrl: '',
  apiBaseUrl: '',
  jiraAuth: null,
  maxJqlResults: 100,
  subject: 'auth0|alice',
};

describe('targetOf', () => {
  it('stages in the scratch space the caller’s token names', () => {
    expect(targetOf({ ...base, sandboxScope: 'project:p1' })).toEqual({
      subject: 'auth0|alice',
      scope: 'project:p1',
    });
  });

  it('is the person’s own scratch space for a token that names none', () => {
    expect(targetOf(base)).toEqual({ subject: 'auth0|alice' });
  });

  it('refuses a request with no identity', () => {
    expect(typeof targetOf({ ...base, subject: undefined })).toBe('string');
  });
});
