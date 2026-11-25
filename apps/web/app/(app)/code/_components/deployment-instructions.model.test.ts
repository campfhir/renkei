import { deploymentInstructions, type InstructionsInput } from './deployment-instructions.model';

const BASE: InstructionsInput = {
  origin: 'https://renkei.example.com',
  projectId: 'proj-1',
  projectName: 'Orders',
  repoFullName: 'acme/orders',
  host: 'github',
  environments: ['staging', 'production'],
};

describe('deploymentInstructions', () => {
  it('says nothing when Renkei has no address it can be reached at', () => {
    expect(deploymentInstructions({ ...BASE, origin: 'not a url' })).toBeNull();
    expect(deploymentInstructions({ ...BASE, origin: '' })).toBeNull();
  });

  it('names the project, the repository and the host, and the exact environment names', () => {
    const text = deploymentInstructions(BASE)!;
    expect(text.startsWith('# Report deployments and health to Renkei: Orders')).toBe(true);
    expect(text).toContain('`acme/orders`');
    expect(text).toContain('`staging`, `production`');
  });

  it('gives the deploy report address and the body fields a deploy sends', () => {
    const text = deploymentInstructions(BASE)!;
    expect(text).toContain('https://renkei.example.com/api/deployments/report');
    for (const field of ['environment', 'status', 'commit', 'branch', 'run', 'target', 'detail']) {
      expect(text).toContain(`\`${field}\``);
    }
  });

  it('writes one deploy job per environment, using the pipeline’s own report snippet', () => {
    const text = deploymentInstructions(BASE)!;
    expect(text).toContain('### Deploy to `staging`');
    expect(text).toContain('### Deploy to `production`');
    // A start and an end report for each environment: four posts to the endpoint.
    const posts = text
      .split('\n')
      .filter((l) => l.includes('-X POST') && l.includes('deployments/report'));
    expect(posts).toHaveLength(4);
    expect(text).toContain('$GITHUB_SHA');
  });

  it('gives a Bitbucket pipeline its own step, with oidc on', () => {
    const text = deploymentInstructions({ ...BASE, host: 'bitbucket' })!;
    expect(text).toContain('oidc: true');
    expect(text).toContain('$BITBUCKET_COMMIT');
    expect(text).not.toContain('$GITHUB_SHA');
  });

  it('describes the health check-in address, the variable names and the body', () => {
    const text = deploymentInstructions(BASE)!;
    expect(text).toContain('https://renkei.example.com/api/health/check-in');
    expect(text).toContain('RENKEI_HEALTH_TOKEN');
    expect(text).toContain('RENKEI_HEALTH_URL');
    for (const status of ['starting', 'healthy', 'degraded', 'error', 'stopping']) {
      expect(text).toContain(`\`${status}\``);
    }
    expect(text).toContain('nextCheckInSeconds');
  });

  it('never writes a token value: the token is named, not shown', () => {
    const text = deploymentInstructions(BASE)!;
    expect(text).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
    expect(text).toContain('Bearer $RENKEI_HEALTH_TOKEN');
  });

  it('tells the reader what to do when no environment exists yet', () => {
    const text = deploymentInstructions({ ...BASE, environments: [] })!;
    expect(text).toContain('none yet');
    expect(text).not.toContain('### Deploy to');
  });

  it('drops a trailing slash from the origin', () => {
    const text = deploymentInstructions({ ...BASE, origin: 'https://renkei.example.com/' })!;
    expect(text).toContain('https://renkei.example.com/api/health/check-in');
    expect(text).not.toContain('com//api');
  });
});
