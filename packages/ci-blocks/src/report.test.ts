import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import {
  renderPipeline,
  reportCommand,
  reportSnippet,
  type BlockDefinition,
  type PipelineContext,
  type PipelineSpec,
} from './index';

const to = {
  url: 'https://renkei.example.com/api/deployments/report',
  audience: 'https://renkei.example.com',
};

const build: BlockDefinition = {
  kind: 'build',
  runsOn: { type: 'hosted', image: 'node:22' },
  inputs: [],
  variables: [],
  consumes: [],
  produces: [{ name: 'dist', paths: ['dist'] }],
  caches: [],
  commands: 'npm run build',
};
const deploy: BlockDefinition = {
  ...build,
  kind: 'deploy',
  runsOn: { type: 'target' },
  consumes: ['dist'],
  produces: [],
  commands: './deploy.sh',
};
const context = (host: 'bitbucket' | 'github'): PipelineContext => ({
  host,
  block: (key) =>
    key === 'build'
      ? { key, name: 'Build', version: 1, definition: build }
      : key === 'deploy'
        ? { key, name: 'Deploy', version: 1, definition: deploy }
        : null,
  target: () => ({ bitbucket: ['self.hosted', 'app'], github: ['self-hosted', 'app'] }),
  report: to,
});
const spec: PipelineSpec = {
  checks: [{ block: 'build', version: 1, inputs: {} }],
  environments: [
    {
      name: 'production',
      branch: 'main',
      steps: [
        { block: 'build', version: 1, inputs: {} },
        { block: 'deploy', version: 1, inputs: {}, target: 'app' },
      ],
    },
  ],
};

const file = (host: 'bitbucket' | 'github') => {
  const rendered = renderPipeline(spec, context(host));
  if (!rendered.ok) throw new Error(rendered.errors.join('\n'));
  return parse(rendered.value);
};

/** Runs a report command with a curl that writes down what it was asked, and answers it. */
function sent(command: string, env: Record<string, string>): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'renkei-report-'));
  const log = path.join(dir, 'calls');
  writeFileSync(
    path.join(dir, 'curl'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${log}\nprintf '%s\\n' '---' >> ${log}\necho '{"count":1,"value":"oidc-token"}'\n`
  );
  chmodSync(path.join(dir, 'curl'), 0o755);
  execFileSync('sh', ['-c', command], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return readFileSync(log, 'utf8').split('---\n').filter(Boolean);
}

describe('every deploy reports to Renkei', () => {
  it('Bitbucket: the deploy step is signed with its own token, reports before it runs and after, however it ends', () => {
    const steps = file('bitbucket').pipelines.branches.main;
    const step = steps[1].step;
    expect(step.oidc).toBe(true);
    expect(step.script).toHaveLength(2);
    expect(step.script[0]).toContain('"status\\":\\"started');
    expect(step.script[1]).toBe('./deploy.sh');
    expect(step['after-script'][0]).toContain('BITBUCKET_EXIT_CODE');
    // The build before it, and pull requests, report nothing.
    expect(steps[0].step.oidc).toBeUndefined();
    expect(
      file('bitbucket').pipelines['pull-requests']['**'][0].step['after-script']
    ).toBeUndefined();
  });

  it('GitHub: the deploy job may ask for a token, reports before its step and always after', () => {
    const job = file('github').jobs['production-deploy'];
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const names = job.steps.map((s: { name?: string; uses?: string }) => s.name ?? s.uses);
    expect(names).toEqual([
      'actions/checkout@v4',
      'actions/download-artifact@v4',
      undefined,
      'Tell Renkei the deploy started',
      'Deploy',
      'Tell Renkei how the deploy went',
    ]);
    expect(job.steps[5]).toMatchObject({
      if: 'always()',
      env: { RENKEI_JOB_STATUS: '${{ job.status }}' },
    });
    expect(file('github').jobs['production-build'].permissions).toBeUndefined();
  });

  it('sends well-formed JSON with the host’s token, and a failed deploy says so', () => {
    const bitbucket = sent(
      `renkei_status=failed; renkei_detail="exit code 3"\n${reportCommand('bitbucket', to, 'production', 'onprem-app', '$renkei_status', '$renkei_detail')}`,
      {
        BITBUCKET_COMMIT: 'abc123',
        BITBUCKET_BRANCH: 'main',
        BITBUCKET_BUILD_NUMBER: '42',
        BITBUCKET_STEP_OIDC_TOKEN: 'bb-token',
      }
    );
    expect(bitbucket).toHaveLength(1);
    const args = bitbucket[0].trim().split('\n');
    expect(args).toContain('Authorization: Bearer bb-token');
    expect(args).toContain(to.url);
    expect(JSON.parse(args[args.indexOf('-d') + 1])).toEqual({
      environment: 'production',
      status: 'failed',
      commit: 'abc123',
      branch: 'main',
      run: '42',
      target: 'onprem-app',
      detail: 'exit code 3',
    });
  });

  it('GitHub asks the runner for a token with Renkei as its audience, then sends it', () => {
    const calls = sent(reportCommand('github', to, 'dev', null, 'started', ''), {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://runner.test/token?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
      GITHUB_SHA: 'def456',
      GITHUB_REF_NAME: 'develop',
      GITHUB_RUN_ID: '9001',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(
      'https://runner.test/token?api-version=2.0&audience=https%3A%2F%2Frenkei.example.com'
    );
    const args = calls[1].trim().split('\n');
    expect(args).toContain('Authorization: Bearer oidc-token');
    expect(JSON.parse(args[args.indexOf('-d') + 1])).toMatchObject({
      environment: 'dev',
      status: 'started',
      commit: 'def456',
      run: '9001',
      target: '',
    });
  });

  it('never fails the deploy when Renkei cannot be reached, or curl is missing', () => {
    const command = reportCommand('bitbucket', to, 'dev', null, 'started', '');
    // No curl on the PATH at all.
    expect(() =>
      execFileSync('/bin/sh', ['-c', `${command}\necho still-deploying`], {
        env: { PATH: '/nonexistent' },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    ).not.toThrow();
    const failing = mkdtempSync(path.join(tmpdir(), 'renkei-report-'));
    writeFileSync(path.join(failing, 'curl'), '#!/bin/sh\nexit 7\n');
    chmodSync(path.join(failing, 'curl'), 0o755);
    const out = execFileSync('/bin/sh', ['-c', `set -e\n${command}\necho still-deploying`], {
      env: { PATH: `${failing}:/usr/bin:/bin` },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    expect(out).toContain('still-deploying');
  });
});

describe('the report for a pipeline written by hand', () => {
  it('Bitbucket: a step that asks for a token, says it started, and says how it went whatever came of it', () => {
    const parsed = parse(reportSnippet('bitbucket', to, 'dev'));
    const step = parsed[0].step;
    expect(step.deployment).toBe('dev');
    expect(step.oidc).toBe(true);
    expect(step.script[0]).toContain('\\"environment\\":\\"dev\\",\\"status\\":\\"started\\"');
    expect(step.script[0]).toContain('$BITBUCKET_STEP_OIDC_TOKEN');
    expect(step.script[1]).toBe('echo "your deploy commands go here"');
    expect(step['after-script'][0]).toContain('$BITBUCKET_EXIT_CODE');
    expect(step['after-script'][0]).toContain('\\"status\\":\\"$renkei_status\\"');
  });

  it('GitHub: a job allowed an id token, with a report before the deploy and one that always runs after', () => {
    const job = parse(reportSnippet('github', to, 'production')).deploy;
    expect(job.environment).toBe('production');
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(job.steps.map((s: { name: string }) => s.name)).toEqual([
      'Tell Renkei the deploy started',
      'Deploy',
      'Tell Renkei how the deploy went',
    ]);
    expect(job.steps[0].run).toContain('audience=https%3A%2F%2Frenkei.example.com');
    expect(job.steps[2].if).toBe('always()');
    expect(job.steps[2].env).toEqual({ RENKEI_JOB_STATUS: '${{ job.status }}' });
    expect(job.steps[2].run).toContain('\\"status\\":\\"$renkei_status\\"');
  });

  it('carries no secret: the host signs it', () => {
    for (const host of ['bitbucket', 'github'] as const) {
      expect(reportSnippet(host, to, 'dev')).not.toMatch(/secret|password|api[_-]?key/i);
    }
  });
});
