import {
  CHANGE_SETTINGS,
  changeDetail,
  changeHeadline,
  changeId,
  changeKind,
  changePath,
  changeSetting,
  changeType,
  changeVariables,
  readChange,
  type DeploymentChange,
  type HealthChanged,
} from './changes';

const deployed = (over: Partial<DeploymentChange> = {}): DeploymentChange => ({
  kind: 'deployment',
  projectId: 'p1',
  environment: 'production',
  status: 'failed',
  deploymentId: 'd1',
  commit: '5c1d9e7af0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
  branch: 'main',
  runUrl: 'https://bitbucket.org/acme/shop/pipelines/results/7',
  detail: null,
  at: '2026-11-24T10:00:00.000Z',
  ...over,
});

const health = (over: Partial<HealthChanged> = {}): HealthChanged => ({
  kind: 'health',
  projectId: 'p1',
  environment: 'production',
  state: 'error',
  previous: 'healthy',
  missed: 0,
  message: 'database unreachable',
  version: '1.4.2',
  at: '2026-11-24T10:00:00.000Z',
  ...over,
});

describe('a change on the queue', () => {
  it('reads back as it was written', () => {
    expect(readChange({ ...deployed() })).toEqual(deployed());
    expect(readChange({ ...health() })).toEqual(health());
  });

  it('is refused when it names no project, or a status or state nobody knows', () => {
    expect(readChange({ ...deployed(), projectId: '' })).toBeNull();
    expect(readChange({ ...deployed(), status: 'exploded' })).toBeNull();
    expect(readChange({ ...health(), state: 'waiting' })).toBeNull();
    expect(readChange('health')).toBeNull();
  });

  it('rides the queue under its own type', () => {
    expect(changeType(deployed())).toBe('deployment.changed');
    expect(changeType(health())).toBe('health.changed');
  });

  it('has one name however often it is delivered', () => {
    expect(changeId(deployed())).toBe('deployment:d1:failed');
    expect(changeId(deployed({ status: 'started' }))).not.toBe(changeId(deployed()));
    expect(changeId(health())).toBe('health:p1:production:error:2026-11-24T10:00:00.000Z');
  });
});

describe('which setting decides who hears of it', () => {
  it('a failed deployment and a successful one have their own; a start has none', () => {
    expect(changeSetting(deployed())).toBe('deploymentFailed');
    expect(changeSetting(deployed({ status: 'succeeded' }))).toBe('deploymentSucceeded');
    expect(changeSetting(deployed({ status: 'started' }))).toBeNull();
  });

  it('failed, stopped, unhealthy and potentially failing each have one', () => {
    expect(changeSetting(health({ state: 'failed' }))).toBe('appFailed');
    expect(changeSetting(health({ state: 'stopped' }))).toBe('appStopped');
    expect(changeSetting(health({ state: 'error' }))).toBe('appUnhealthy');
    expect(changeSetting(health({ state: 'degraded' }))).toBe('appUnhealthy');
    expect(changeSetting(health({ state: 'late' }))).toBe('appLate');
  });

  it('healthy is news only after trouble', () => {
    expect(changeSetting(health({ state: 'healthy', previous: 'failed' }))).toBe('appRecovered');
    expect(changeSetting(health({ state: 'healthy', previous: 'starting' }))).toBeNull();
    expect(changeSetting(health({ state: 'healthy', previous: null }))).toBeNull();
  });

  it('starting and saying it will stop are nobody’s notification', () => {
    expect(changeSetting(health({ state: 'starting', previous: null }))).toBeNull();
    expect(changeSetting(health({ state: 'stopping' }))).toBeNull();
  });

  it('spells a row’s kind from the setting', () => {
    expect(CHANGE_SETTINGS.map(changeKind)).toEqual([
      'deployment_failed',
      'deployment_succeeded',
      'app_failed',
      'app_stopped',
      'app_unhealthy',
      'app_late',
      'app_recovered',
    ]);
  });
});

describe('how a change reads', () => {
  it('a failed deployment names the environment, the project and the commit', () => {
    expect(changeHeadline(deployed(), 'Shop')).toBe('Deploying production of “Shop” failed');
    expect(changeDetail(deployed({ detail: 'exit code 1' }))).toBe(
      'Commit 5c1d9e7 on main. exit code 1'
    );
  });

  it('an application that went quiet says how quiet', () => {
    expect(changeHeadline(health({ state: 'late' }), 'Shop')).toBe(
      'production of “Shop” may be failing'
    );
    expect(changeDetail(health({ state: 'failed', missed: 3 }))).toBe(
      'It missed 3 check-ins in a row.'
    );
    expect(changeHeadline(health({ state: 'stopped' }), 'Shop')).toBe(
      'production of “Shop” has stopped'
    );
  });

  it('an application that reports a problem says it in its own words', () => {
    expect(changeHeadline(health(), 'Shop')).toBe('production of “Shop” reports an error');
    expect(changeDetail(health())).toBe('database unreachable');
  });

  it('coming back reads as coming back', () => {
    expect(changeHeadline(health({ state: 'healthy', previous: 'failed' }), 'Shop')).toBe(
      'production of “Shop” is healthy again'
    );
  });

  it('opens on the environment, on the project’s page', () => {
    expect(changePath(health({ environment: 'test lab' }))).toBe(
      '/code/p1/environments?env=test%20lab'
    );
  });
});

describe('what a woken agent is handed', () => {
  const project = { name: 'Shop', repository: 'acme/shop' };

  it('a deployment: where, what came of it and the commit, all as text', () => {
    expect(changeVariables(deployed(), project)).toEqual({
      changeId: 'deployment:d1:failed',
      projectId: 'p1',
      project: 'Shop',
      repository: 'acme/shop',
      environment: 'production',
      summary: 'Deploying production of “Shop” failed. Commit 5c1d9e7 on main.',
      at: '2026-11-24T10:00:00.000Z',
      status: 'failed',
      commit: '5c1d9e7af0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
      branch: 'main',
      runUrl: 'https://bitbucket.org/acme/shop/pipelines/results/7',
      detail: '',
    });
  });

  it('a health change: the state, the one before, and what the application said', () => {
    expect(changeVariables(health(), project)).toMatchObject({
      state: 'error',
      previous: 'healthy',
      missed: '0',
      message: 'database unreachable',
      version: '1.4.2',
    });
  });
});
