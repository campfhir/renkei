import type { Runner } from '@renkei/ci-blocks';
import {
  accountCards,
  accountProblems,
  accountRequest,
  initialTargetsPage,
  knownLabels,
  looseRows,
  targetCards,
  targetFormProblems,
  targetRequest,
  targetsPageReducer,
  type TargetsPageAction,
  type TargetsPageData,
  type TargetsPageState,
} from './targets-page.model';

const NOW = Date.parse('2026-11-18T10:04:00.000Z');
const runner = (overrides: Partial<Runner>): Runner => ({
  host: 'bitbucket',
  id: 'r',
  name: 'app-01',
  labels: ['self.hosted', 'linux', 'onprem-app'],
  status: 'online',
  busy: false,
  ...overrides,
});

const data: TargetsPageData = {
  accounts: {
    bitbucket: { workspace: 'acme', auth: 'bearer', email: '', hasToken: true },
    github: { org: 'acme-labs', appId: '42', hasKey: true },
  },
  hosts: {
    bitbucket: { connected: true, readAt: '2026-11-18T10:00:00.000Z', error: null, count: 3 },
    github: {
      connected: true,
      readAt: null,
      error: 'The GitHub App is not installed on acme-labs; install it there first.',
      count: 0,
    },
  },
  targets: [
    {
      id: 't1',
      name: 'onprem-workers',
      description: 'Background workers',
      labels: {
        bitbucket: ['self.hosted', 'onprem-workers'],
        github: ['self-hosted', 'onprem-workers'],
      },
      runners: {
        bitbucket: [
          runner({ id: '1', name: 'workers-01', labels: ['self.hosted', 'onprem-workers'] }),
        ],
        github: [
          runner({
            host: 'github',
            id: '2',
            name: 'workers-02',
            status: 'offline',
            labels: ['self-hosted', 'onprem-workers'],
          }),
        ],
      },
      online: 1,
      total: 2,
    },
    {
      id: 't2',
      name: 'gh-build',
      description: null,
      labels: { bitbucket: [], github: ['self-hosted', 'build'] },
      runners: { bitbucket: [], github: [] },
      online: 0,
      total: 0,
    },
  ],
  loose: [
    runner({
      id: '3',
      name: 'dmz-edge-01',
      labels: ['self.hosted', 'linux', 'dmz'],
      status: 'unregistered',
    }),
  ],
};

const run = (actions: TargetsPageAction[], start: TargetsPageState = initialTargetsPage) =>
  actions.reduce(targetsPageReducer, start);
const loaded = run([{ type: 'loaded', data }]);

describe('the service accounts', () => {
  it('say how each signs in and what it read, or why it could not', () => {
    expect(accountCards(data, NOW)).toEqual([
      {
        host: 'bitbucket',
        title: 'Bitbucket workspace acme',
        state: 'connected',
        how: 'Workspace access token.',
        status: '3 runners · read 4 minutes ago',
      },
      {
        host: 'github',
        title: 'GitHub organization acme-labs',
        state: 'failing',
        how: 'GitHub App 42.',
        status: 'The GitHub App is not installed on acme-labs; install it there first.',
      },
    ]);
  });

  it('opens a form from what is stored, never with the secret, and saving keeps it when left blank', () => {
    const state = run([{ type: 'openAccount', host: 'github' }], loaded);
    expect(state.account).toMatchObject({
      account: 'acme-labs',
      appId: '42',
      secret: '',
      hasSecret: true,
    });
    expect(accountProblems(state.account!)).toEqual([]);
    expect(accountRequest(state.account!)).toEqual({
      url: '/api/admin/ci-accounts/github',
      body: { org: 'acme-labs', appId: '42', privateKey: '' },
    });
  });

  it('asks a new bot account for its email and token', () => {
    const state = run([
      { type: 'loaded', data: { ...data, accounts: { bitbucket: null, github: null } } },
      { type: 'openAccount', host: 'bitbucket' },
      { type: 'accountField', patch: { account: 'acme', auth: 'basic', email: 'nope' } },
    ]);
    expect(accountProblems(state.account!)).toEqual([
      'A bot account signs in with its email.',
      'Paste the token.',
    ]);
    const fixed = run(
      [{ type: 'accountField', patch: { email: 'ci-bot@acme.test', secret: 'api-token' } }],
      state
    );
    expect(accountRequest(fixed.account!).body).toEqual({
      workspace: 'acme',
      auth: 'basic',
      email: 'ci-bot@acme.test',
      token: 'api-token',
    });
  });
});

describe('the targets', () => {
  it('read each target’s health and, per host, its labels and runners', () => {
    expect(targetCards(data)).toEqual([
      {
        id: 't1',
        name: 'onprem-workers',
        description: 'Background workers',
        health: '1 of 2 online',
        tone: 'warn',
        hosts: [
          {
            host: 'bitbucket',
            name: 'Bitbucket',
            labels: ['self.hosted', 'onprem-workers'],
            runners: 'workers-01 online',
          },
          {
            host: 'github',
            name: 'GitHub',
            labels: ['self-hosted', 'onprem-workers'],
            runners: 'workers-02 offline',
          },
        ],
      },
      {
        id: 't2',
        name: 'gh-build',
        description: null,
        health: 'No runners found',
        tone: 'none',
        hosts: [
          {
            host: 'github',
            name: 'GitHub',
            labels: ['self-hosted', 'build'],
            runners: 'No runner carries these labels.',
          },
        ],
      },
    ]);
  });

  it('lists runners in no target, and makes a target from one’s labels', () => {
    expect(looseRows(data).map((row) => [row.runner.name, row.host, row.status])).toEqual([
      ['dmz-edge-01', 'Bitbucket', 'unregistered'],
    ]);
    const state = run([{ type: 'targetFromRunner', runner: data.loose[0] }], loaded);
    expect(state.target).toEqual({
      id: null,
      name: 'dmz',
      description: '',
      bitbucket: 'self.hosted, linux, dmz',
      github: '',
    });
    expect(targetFormProblems(state.target!)).toEqual([]);
    expect(targetRequest(state.target!)).toEqual({
      url: '/api/admin/ci-targets',
      method: 'POST',
      body: {
        name: 'dmz',
        description: null,
        labels: { bitbucket: ['self.hosted', 'linux', 'dmz'], github: [] },
      },
    });
  });

  it('edits a target as it is, and names what is wrong as it is typed', () => {
    const state = run(
      [
        { type: 'editTarget', id: 't2' },
        { type: 'targetField', patch: { github: 'linux build' } },
      ],
      loaded
    );
    expect(targetFormProblems(state.target!)).toEqual([
      'GitHub labels must include self-hosted, or the job goes to a hosted runner.',
    ]);
    expect(targetRequest(state.target!)).toMatchObject({
      url: '/api/admin/ci-targets/t2',
      method: 'PUT',
    });
  });

  it('suggests the labels each host’s runners carry', () => {
    expect(knownLabels(data, 'bitbucket')).toEqual([
      'dmz',
      'linux',
      'onprem-workers',
      'self.hosted',
    ]);
  });

  it('closes the form when a save comes back, and keeps it open on a refusal, with the problems', () => {
    const open = run([{ type: 'newTarget' }, { type: 'sent', busy: 'target' }], loaded);
    expect(
      run([{ type: 'failed', error: 'The target cannot be saved yet.', problems: ['x'] }], open)
    ).toMatchObject({
      target: { name: '' },
      problems: ['x'],
    });
    expect(run([{ type: 'loaded', data, notice: 'Target saved.' }], open)).toMatchObject({
      target: null,
      notice: 'Target saved.',
    });
  });
});
