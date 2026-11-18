import {
  parseBitbucketRunners,
  parseGithubRunners,
  runnersInNoTarget,
  splitLabels,
  targetFromRunner,
  targetHealth,
  targetProblems,
  type Runner,
} from './index';

/** GitHub's answer for an organization with two runners. */
const github = {
  total_count: 2,
  runners: [
    {
      id: 21,
      name: 'workers-02',
      os: 'linux',
      status: 'offline',
      busy: false,
      labels: [
        { id: 1, name: 'self-hosted', type: 'read-only' },
        { id: 2, name: 'Linux', type: 'read-only' },
        { id: 9, name: 'onprem-workers', type: 'custom' },
      ],
    },
    {
      id: 22,
      name: 'build-mac-01',
      status: 'online',
      busy: true,
      labels: [{ name: 'self-hosted' }, { name: 'macOS' }],
    },
  ],
};

/** Bitbucket's answer for a workspace with two runners. */
const bitbucket = {
  pagelen: 300,
  values: [
    {
      uuid: '{a1}',
      name: 'workers-01',
      labels: ['self.hosted', 'linux', 'onprem-workers'],
      state: { status: 'ONLINE', updated_on: '2026-11-18T08:00:00Z' },
    },
    {
      uuid: '{a2}',
      name: 'dmz-edge-01',
      labels: ['self.hosted', 'linux', 'dmz'],
      state: { status: 'UNREGISTERED' },
    },
    {
      uuid: '{a3}',
      name: 'workers-03',
      labels: ['self.hosted', 'linux', 'onprem-workers'],
      state: { status: 'ONLINE', cordoned: true },
    },
  ],
};

const runners: Runner[] = [...parseGithubRunners(github), ...parseBitbucketRunners(bitbucket)];
const workers = {
  name: 'onprem-workers',
  labels: {
    bitbucket: ['self.hosted', 'linux', 'onprem-workers'],
    github: ['self-hosted', 'linux', 'onprem-workers'],
  },
};

describe('reading the hosts’ runners', () => {
  it('reads GitHub’s labels and status, and Bitbucket’s', () => {
    expect(runners).toEqual([
      {
        host: 'github',
        id: '21',
        name: 'workers-02',
        labels: ['self-hosted', 'Linux', 'onprem-workers'],
        status: 'offline',
        busy: false,
      },
      {
        host: 'github',
        id: '22',
        name: 'build-mac-01',
        labels: ['self-hosted', 'macOS'],
        status: 'online',
        busy: true,
      },
      {
        host: 'bitbucket',
        id: '{a1}',
        name: 'workers-01',
        labels: ['self.hosted', 'linux', 'onprem-workers'],
        status: 'online',
        busy: false,
      },
      {
        host: 'bitbucket',
        id: '{a2}',
        name: 'dmz-edge-01',
        labels: ['self.hosted', 'linux', 'dmz'],
        status: 'unregistered',
        busy: false,
      },
      {
        host: 'bitbucket',
        id: '{a3}',
        name: 'workers-03',
        labels: ['self.hosted', 'linux', 'onprem-workers'],
        status: 'cordoned',
        busy: false,
      },
    ]);
  });

  it('reads each status Bitbucket reports', () => {
    const statuses = [
      'ONLINE',
      'OFFLINE',
      'UNREGISTERED',
      'DISABLED',
      'UNHEALTHY',
      'ENABLED',
      'NEW',
    ];
    expect(
      parseBitbucketRunners({
        values: statuses.map((status) => ({ uuid: status, name: status, state: { status } })),
      }).map((r) => r.status)
    ).toEqual(['online', 'offline', 'unregistered', 'disabled', 'unhealthy', 'offline', 'offline']);
  });

  it('reads nothing from an answer that is not one', () => {
    expect(parseGithubRunners({ message: 'Not Found' })).toEqual([]);
    expect(parseBitbucketRunners(null)).toEqual([]);
  });
});

describe('which runners a target has', () => {
  it('takes a runner carrying every label for its host, case aside, on both hosts; a cordoned one is not online', () => {
    const health = targetHealth(workers, runners);
    expect(health.byHost.github.map((r) => r.name)).toEqual(['workers-02']);
    expect(health.byHost.bitbucket.map((r) => r.name)).toEqual(['workers-01', 'workers-03']);
    expect({ total: health.total, online: health.online }).toEqual({ total: 3, online: 1 });
  });

  it('lists the runners no target takes', () => {
    expect(runnersInNoTarget([workers], runners).map((r) => r.name)).toEqual([
      'build-mac-01',
      'dmz-edge-01',
    ]);
  });

  it('makes a target from a runner, named after its own label', () => {
    expect(targetFromRunner(runners[3])).toEqual({
      name: 'dmz',
      labels: { bitbucket: ['self.hosted', 'linux', 'dmz'], github: [] },
    });
    // Only the host's defaults: named after the runner.
    expect(targetFromRunner(runners[1]).name).toBe('build-mac-01');
  });
});

describe('what a target may be', () => {
  it('accepts labels for one host or both', () => {
    expect(targetProblems(workers)).toEqual([]);
    expect(
      targetProblems({ name: 'dmz', labels: { bitbucket: ['self.hosted', 'dmz'], github: [] } })
    ).toEqual([]);
  });

  it('names what is wrong: the name, no labels, a missing self-hosted label, labels that name nothing', () => {
    expect(targetProblems({ name: 'On Prem', labels: { bitbucket: [], github: [] } })).toEqual([
      'Name the target in lower case: letters, digits and -, like onprem-app.',
      'Give the target runner labels for Bitbucket, GitHub or both.',
    ]);
    expect(
      targetProblems({
        name: 'onprem',
        labels: { bitbucket: ['linux', 'onprem'], github: ['self-hosted'] },
      })
    ).toEqual([
      'Bitbucket labels must include self.hosted, or the job goes to a hosted runner.',
      'GitHub labels need more than self-hosted: one that names these machines.',
    ]);
  });

  it('reads labels however they were typed, each once', () => {
    expect(splitLabels('self.hosted, linux\n onprem-app  Linux')).toEqual([
      'self.hosted',
      'linux',
      'onprem-app',
    ]);
  });
});
