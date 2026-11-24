import {
  assignedBranches,
  defaultEnvironments,
  environmentNameProblem,
  environmentOfBranch,
  environmentProblems,
  normalizeEnvironments,
  readEnvironmentList,
  renamed,
  withBranch,
  withEnvironment,
  withoutBranch,
  withoutEnvironment,
  type ProjectEnvironment,
} from './environment-rules';

const list: ProjectEnvironment[] = [
  { name: 'production', production: true, branches: ['main'] },
  { name: 'dev', production: false, branches: ['develop', 'feature/intake'] },
  { name: 'staging', production: false, branches: [] },
];

describe('a project’s environments', () => {
  it('start as the production environment, with no branch yet', () => {
    expect(defaultEnvironments()).toEqual([{ name: 'production', production: true, branches: [] }]);
    expect(normalizeEnvironments([])).toEqual(defaultEnvironments());
  });

  it('a list that follows the rules has nothing wrong with it', () => {
    expect(environmentProblems(list)).toEqual([]);
  });

  it('are named as the project likes, once each', () => {
    expect(
      environmentProblems([
        { name: 'live', production: true, branches: [] },
        { name: 'qa-2', production: false, branches: [] },
        { name: 'QA-2', production: false, branches: [] },
        { name: '2fast', production: false, branches: [] },
      ])
    ).toEqual([
      'Two environments are named QA-2.',
      '“2fast” is not a usable environment name: it starts with a letter and holds letters, digits, - and _.',
    ]);
  });
});

describe('the production environment', () => {
  it('is exactly one', () => {
    expect(
      environmentProblems([
        { name: 'dev', production: false, branches: [] },
        { name: 'test', production: false, branches: [] },
      ])
    ).toEqual(['One environment is the production one; none is marked so.']);
    expect(
      environmentProblems([
        { name: 'live', production: true, branches: [] },
        { name: 'prod', production: true, branches: [] },
      ])
    ).toEqual(['Only one environment is the production one; live and prod are both marked so.']);
  });

  it('deploys from one branch', () => {
    expect(
      environmentProblems([{ name: 'production', production: true, branches: ['main', 'release'] }])
    ).toEqual([
      'production is the production environment and deploys from one branch; it was given main and release.',
    ]);
  });

  it('takes another branch in place of the one it had', () => {
    const next = withBranch(list, 'production', 'release');
    expect(next[0]).toEqual({ name: 'production', production: true, branches: ['release'] });
    expect(environmentProblems(next)).toEqual([]);
  });

  it('cannot be removed, but can be renamed', () => {
    expect(withoutEnvironment(list, 'production')).toEqual(list);
    expect(renamed(list, 'production', 'live')[0]).toEqual({
      name: 'live',
      production: true,
      branches: ['main'],
    });
  });
});

describe('branches', () => {
  it('any other environment holds as many as it likes', () => {
    const next = withBranch(list, 'staging', 'release/2.0');
    expect(withBranch(next, 'staging', 'hotfix').at(-1)?.branches).toEqual([
      'release/2.0',
      'hotfix',
    ]);
  });

  it('a branch deploys one environment: assigning it moves it', () => {
    const next = withBranch(list, 'staging', 'develop');
    expect(environmentOfBranch(next, 'develop')?.name).toBe('staging');
    expect(next[1]?.branches).toEqual(['feature/intake']);
    expect(environmentProblems(next)).toEqual([]);
  });

  it('a list that names a branch twice is refused', () => {
    expect(
      environmentProblems([
        { name: 'production', production: true, branches: ['main'] },
        { name: 'dev', production: false, branches: ['main', 'develop', 'develop'] },
      ])
    ).toEqual([
      'main is assigned to both production and dev; a branch deploys one environment.',
      'develop is assigned to dev twice.',
    ]);
  });

  it('are ones the remote has', () => {
    expect(
      environmentProblems(withBranch(list, 'staging', 'made-up'), {
        remoteBranches: ['main', 'develop', 'feature/intake'],
        assignedBefore: assignedBranches(list),
      })
    ).toEqual([
      'The repository has no branch made-up; an environment is assigned branches that exist on the remote.',
    ]);
  });

  it('one assigned before stays even when the remote has dropped it, so it can be taken off', () => {
    expect(
      environmentProblems(list, {
        remoteBranches: ['main', 'develop'],
        assignedBefore: assignedBranches(list),
      })
    ).toEqual([]);
    expect(withoutBranch(list, 'dev', 'feature/intake')[1]?.branches).toEqual(['develop']);
  });

  it('a name that is not a branch is refused', () => {
    expect(
      environmentProblems([{ name: 'production', production: true, branches: ['a..b'] }])
    ).toEqual(['“a..b” is not a branch name.']);
  });
});

describe('adding and renaming', () => {
  it('a new environment starts with no branches and is not production', () => {
    expect(withEnvironment(list, ' test ').at(-1)).toEqual({
      name: 'test',
      production: false,
      branches: [],
    });
  });

  it('a name is checked as it is typed', () => {
    expect(environmentNameProblem(list, '')).toBe('Give the environment a name.');
    expect(environmentNameProblem(list, 'Dev')).toBe('There is already an environment named Dev.');
    expect(environmentNameProblem(list, 'my env')).toBe(
      'A name starts with a letter and holds letters, digits, - and _, up to 40.'
    );
    expect(environmentNameProblem(list, 'test')).toBeNull();
    // Renaming one to a different spelling of its own name is fine.
    expect(environmentNameProblem(list, 'Dev', 'dev')).toBeNull();
  });
});

describe('a stored list is made one the rules hold for', () => {
  it('the environment named production is the production one when none is marked', () => {
    expect(
      normalizeEnvironments([
        { name: 'dev', production: false, branches: ['develop'] },
        { name: 'Production', production: false, branches: ['main'] },
      ]).map((e) => [e.name, e.production])
    ).toEqual([
      ['dev', false],
      ['Production', true],
    ]);
  });

  it('a list with none gets one in front', () => {
    expect(
      normalizeEnvironments([{ name: 'dev', production: false, branches: ['develop'] }]).map(
        (e) => e.name
      )
    ).toEqual(['production', 'dev']);
  });

  it('only the first marked is production, with one branch, and a branch stays where it first is', () => {
    expect(
      normalizeEnvironments([
        { name: 'live', production: true, branches: ['main', 'release'] },
        { name: 'other', production: true, branches: ['main', 'develop'] },
      ])
    ).toEqual([
      { name: 'live', production: true, branches: ['main'] },
      { name: 'other', production: false, branches: ['develop'] },
    ]);
  });
});

describe('a sent list', () => {
  it('is read for shape, names and branches trimmed', () => {
    expect(
      readEnvironmentList([{ name: ' dev ', production: 'yes', branches: [' develop '] }])
    ).toEqual([{ name: 'dev', production: false, branches: ['develop'] }]);
  });

  it('is refused when it is not a list of environments', () => {
    expect(readEnvironmentList({})).toBeNull();
    expect(readEnvironmentList([{ name: 'dev' }])).toBeNull();
    expect(readEnvironmentList([{ name: 'dev', branches: [1] }])).toBeNull();
  });
});
