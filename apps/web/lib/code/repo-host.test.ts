import { GITHUB, ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import { hostAdapterFor } from './repo-host';

const context = { tenantId: 't1', subject: 'person@example.com', origin: 'https://example.test' };

describe('hostAdapterFor', () => {
  it('dispatches GitHub for the GITHUB provider-grants constant', () => {
    expect(hostAdapterFor(GITHUB, context)).not.toBeNull();
  });

  it('dispatches Bitbucket for the ATLASSIAN_BITBUCKET provider-grants constant', () => {
    // chat_projects.repo_provider is written as this exact constant
    // (api/tenant/[tenantId]/code/projects/route.ts) — a bare 'bitbucket'
    // literal here previously made every real Bitbucket project's
    // Pulls/Commits card read "host not supported".
    expect(ATLASSIAN_BITBUCKET).toBe('atlassian-bitbucket');
    expect(hostAdapterFor(ATLASSIAN_BITBUCKET, context)).not.toBeNull();
  });

  it('returns null for a bare "bitbucket" string and any other unknown provider', () => {
    expect(hostAdapterFor('bitbucket', context)).toBeNull();
    expect(hostAdapterFor('gitlab', context)).toBeNull();
    expect(hostAdapterFor('', context)).toBeNull();
  });
});
