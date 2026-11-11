import {
  looksLikeSecret,
  planVariableWrite,
  renderVariableSet,
  renderWriteOutcome,
} from './pipeline-variable-plan';

const valid = () => null;

describe('which names a chat may write', () => {
  it('writes plain variables and leaves the ones it did not name alone', () => {
    const plan = planVariableWrite(
      [{ key: 'REGION', secured: false }],
      { variables: { REGION: 'eu', API_BASE_URL: 'https://api.test' }, remove: [] },
      valid
    );
    expect(plan.set).toEqual([
      { key: 'REGION', value: 'eu' },
      { key: 'API_BASE_URL', value: 'https://api.test' },
    ]);
    expect(plan.remove).toEqual([]);
    expect(plan.refused).toEqual([]);
  });

  it('never replaces or removes a secured variable, and says why', () => {
    const plan = planVariableWrite(
      [{ key: 'DEPLOY_KEY', secured: true }],
      { variables: { DEPLOY_KEY: 'x' }, remove: ['DEPLOY_KEY'] },
      valid
    );
    expect(plan.set).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.refused.map((entry) => entry.key)).toEqual(['DEPLOY_KEY', 'DEPLOY_KEY']);
    expect(plan.refused[0]?.reason).toMatch(/only the person/);
  });

  it('does not write a value for a name that reads as a secret', () => {
    const plan = planVariableWrite(
      [],
      { variables: { NPM_TOKEN: 'abc', REGISTRY_URL: 'https://r.test' }, remove: [] },
      valid
    );
    expect(plan.set).toEqual([{ key: 'REGISTRY_URL', value: 'https://r.test' }]);
    expect(plan.refused).toEqual([
      { key: 'NPM_TOKEN', reason: expect.stringContaining('reads as a secret') },
    ]);
  });

  it('refuses what the host would refuse, naming the problem', () => {
    const plan = planVariableWrite([], { variables: { '1BAD': 'x' }, remove: [] }, (key) =>
      /^\d/.test(key) ? `${key} is not a name` : null
    );
    expect(plan.set).toEqual([]);
    expect(plan.refused).toEqual([{ key: '1BAD', reason: '1BAD is not a name' }]);
  });

  it('removes plain variables that exist, and says so for ones that do not', () => {
    const plan = planVariableWrite(
      [{ key: 'OLD', secured: false }],
      { variables: {}, remove: ['OLD', 'NEVER_THERE'] },
      valid
    );
    expect(plan.remove).toEqual(['OLD']);
    expect(plan.refused).toEqual([
      { key: 'NEVER_THERE', reason: 'is not set, so there is nothing to remove' },
    ]);
  });

  it('reads a secret-looking name only by its pattern', () => {
    expect(['API_KEY', 'github_token', 'DB_PASSWORD', 'PRIVATE_KEY'].every(looksLikeSecret)).toBe(
      true
    );
    expect(['REGION', 'API_BASE_URL', 'S3_BUCKET'].some(looksLikeSecret)).toBe(false);
  });
});

describe('how the model reads a set and a write', () => {
  it('shows a secured variable by name with its value omitted', () => {
    expect(
      renderVariableSet('Repository variables', [
        { key: 'REGION', value: 'eu', secured: false },
        { key: 'DEPLOY_TOKEN', value: null, secured: true },
      ])
    ).toBe('Repository variables:\n  REGION=eu\n  DEPLOY_TOKEN — secured, value omitted');
    expect(renderVariableSet('Repository variables', [])).toBe('Repository variables: none.');
  });

  it('reports what landed, what the host refused and what was left alone', () => {
    const plan = planVariableWrite([], { variables: { NPM_TOKEN: 'x' }, remove: [] }, valid);
    expect(
      renderWriteOutcome(plan, { added: ['A'], changed: [], removed: [], errors: ['B: no'] })
    ).toBe(
      'added A.\nThe host refused: B: no.\nLeft alone: NPM_TOKEN reads as a secret, so no value is written from a chat; the person adds it as a secured variable on the Pipelines page.'
    );
  });
});
