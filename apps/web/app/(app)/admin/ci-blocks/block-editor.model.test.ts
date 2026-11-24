import {
  blockEditorReducer,
  canPublish,
  canSave,
  definitionOf,
  initialEditor,
  isDirty,
  previewOf,
  problemsOf,
  publishLabel,
  saveRequest,
  statusOf,
  type BlockDetailView,
  type BlockEditorAction,
  type BlockEditorState,
} from './block-editor.model';

const run = (actions: BlockEditorAction[], start = initialEditor(null)): BlockEditorState =>
  actions.reduce(blockEditorReducer, start);

/** A person filling in a systemd deploy block from scratch. */
const filledIn: BlockEditorAction[] = [
  { type: 'field', field: 'key', value: 'deploy-systemd' },
  { type: 'field', field: 'name', value: 'Deploy with systemd' },
  { type: 'kind', kind: 'deploy' },
  { type: 'runsOn', runsOn: 'target' },
  { type: 'addRow', list: 'inputs' },
  { type: 'input', index: 0, patch: { name: 'service_name' } },
  { type: 'addRow', list: 'variables' },
  { type: 'variable', index: 0, patch: { name: 'DEPLOY_TOKEN', secured: true } },
  { type: 'field', field: 'consumes', value: 'dist' },
  { type: 'field', field: 'commands', value: 'sudo systemctl restart ${input.service_name}' },
];

const publishedDefinition = {
  kind: 'test',
  runsOn: { type: 'hosted', image: 'node:22' },
  inputs: [],
  variables: [],
  consumes: [],
  produces: [{ name: 'report', paths: ['junit.xml'] }],
  caches: [{ name: 'npm', path: '~/.npm', keyFiles: ['package-lock.json'] }],
  commands: 'npm ci\nnpm test',
};

const published: BlockDetailView = {
  id: 'b1',
  key: 'node-test',
  name: 'Node test',
  description: 'npm test',
  kind: 'test',
  latestVersion: 2,
  draft: null,
  published: {
    kind: 'test',
    runsOn: { type: 'hosted', image: 'node:22' },
    inputs: [],
    variables: [],
    consumes: [],
    produces: [{ name: 'report', paths: ['junit.xml'] }],
    caches: [{ name: 'npm', path: '~/.npm', keyFiles: ['package-lock.json'] }],
    commands: 'npm ci\nnpm test',
  },
  versions: [
    { version: 2, publishedBy: 'ada@example.com', publishedAt: '2026-11-01T10:00:00.000Z' },
  ],
};

describe('a new block', () => {
  it('says what is missing before anything is filled in, and offers neither Save nor Publish', () => {
    const state = initialEditor(null);
    expect(problemsOf(state)).toEqual([
      'The key is how pipelines name the block: lower case letters, digits and -, starting with a letter.',
      'Give the block a name.',
      'A block that runs on a hosted runner needs a container image, e.g. node:22.',
      'The block needs at least one command.',
    ]);
    expect(canSave(state)).toBe(false);
    expect(canPublish(state)).toBe(false);
    expect(previewOf(state)).toBeNull();
  });

  it('makes the definition the form shows, and previews it for Bitbucket, then GitHub', () => {
    const state = run(filledIn);
    expect(problemsOf(state)).toEqual([]);
    expect(definitionOf(state.form)).toEqual({
      kind: 'deploy',
      runsOn: { type: 'target' },
      inputs: [{ name: 'service_name', type: 'text' }],
      variables: [{ name: 'DEPLOY_TOKEN', secured: true }],
      consumes: ['dist'],
      produces: [],
      caches: [],
      commands: 'sudo systemctl restart ${input.service_name}',
    });
    expect(previewOf(state)).toContain('runs-on:\n      - self.hosted');
    expect(previewOf(state)).toContain('sudo systemctl restart <service_name>');
    const github = blockEditorReducer(state, { type: 'host', host: 'github' });
    expect(previewOf(github)).toContain('DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}');
  });

  it('may be saved half-finished, but published only once it reads whole', () => {
    const half = run([
      { type: 'field', field: 'key', value: 'wip' },
      { type: 'field', field: 'name', value: 'Work in progress' },
    ]);
    expect(canSave(half)).toBe(true);
    expect(canPublish(half)).toBe(false);
    expect(canPublish(run(filledIn))).toBe(true);
  });

  it('is created with its key by Save, and keeps that key afterwards', () => {
    const state = run(filledIn);
    expect(saveRequest(state)).toEqual({
      url: '/api/admin/ci-blocks',
      method: 'POST',
      body: expect.objectContaining({
        key: 'deploy-systemd',
        name: 'Deploy with systemd',
        kind: 'deploy',
      }),
    });
    const saved = run(
      [
        { type: 'sent', busy: 'save' },
        { type: 'saved', id: 'new-id' },
      ],
      state
    );
    expect(saved.blockId).toBe('new-id');
    expect(isDirty(saved)).toBe(false);
    expect(saveRequest(saved)).toMatchObject({ url: '/api/admin/ci-blocks/new-id', method: 'PUT' });
    expect(
      blockEditorReducer(saved, { type: 'field', field: 'key', value: 'renamed' }).form.key
    ).toBe('deploy-systemd');
  });
});

describe('an existing block', () => {
  it('opens from its published version, unchanged', () => {
    const state = run([{ type: 'loaded', block: published }], initialEditor('b1'));
    expect(state.form).toMatchObject({
      key: 'node-test',
      runsOn: 'hosted',
      image: 'node:22',
      produces: [{ name: 'report', paths: 'junit.xml' }],
      caches: [{ name: 'npm', path: '~/.npm', keyFiles: 'package-lock.json' }],
    });
    expect(statusOf(state)).toBe('v2 published');
    expect(canSave(state)).toBe(false);
    expect(canPublish(state)).toBe(false);
  });

  it('opens from its draft when it has one, offering v3', () => {
    const state = run(
      [
        {
          type: 'loaded',
          block: {
            ...published,
            draft: { ...publishedDefinition, commands: 'npm test -- --ci' },
          },
        },
      ],
      initialEditor('b1')
    );
    expect(state.form.commands).toBe('npm test -- --ci');
    expect(statusOf(state)).toBe('v2 published · unpublished changes');
    expect(canPublish(state)).toBe(true);
    expect(publishLabel(state)).toBe('Publish v3');
  });

  it('a refused publish keeps the form and lists each problem the server named', () => {
    const state = run(
      [
        { type: 'loaded', block: published },
        { type: 'field', field: 'commands', value: 'npm test' },
        { type: 'sent', busy: 'publish' },
        {
          type: 'failed',
          error: 'The block cannot be published until these are fixed.',
          problems: ['A problem'],
        },
      ],
      initialEditor('b1')
    );
    expect(state.form.commands).toBe('npm test');
    expect(state.problems).toEqual(['A problem']);
    expect(state.busy).toBeNull();
  });

  it('a publish moves the version on and clears the draft', () => {
    const state = run(
      [
        { type: 'loaded', block: published },
        { type: 'field', field: 'commands', value: 'npm test' },
        { type: 'sent', busy: 'publish' },
        { type: 'published', version: 3 },
      ],
      initialEditor('b1')
    );
    expect(statusOf(state)).toBe('v3 published');
    expect(state.versions.map((v) => v.version)).toEqual([3, 2]);
  });
});

describe('a draft from the AI', () => {
  it('fills the form without saving it, and says so', () => {
    const state = run([
      {
        type: 'drafted',
        key: 'deploy-compose',
        name: 'Deploy with Compose',
        definition: {
          kind: 'deploy',
          runsOn: { type: 'target' },
          commands: 'docker compose up -d',
        },
      },
    ]);
    expect(state.form).toMatchObject({
      key: 'deploy-compose',
      kind: 'deploy',
      runsOn: 'target',
      commands: 'docker compose up -d',
    });
    expect(isDirty(state)).toBe(true);
    expect(state.notice).toBe(
      'Drafted. Check every field before saving: nothing is saved until you do.'
    );
  });
});
