import {
  blocksListReducer,
  emptyLine,
  initialBlocksList,
  visibleRows,
  type BlockSummaryView,
} from './blocks-list.model';

const block = (overrides: Partial<BlockSummaryView>): BlockSummaryView => ({
  id: 'b',
  key: 'node-test',
  name: 'Node: install, lint, test',
  description: 'npm ci, lint, test',
  kind: 'test',
  latestVersion: 4,
  hasDraft: false,
  runsOn: 'hosted',
  image: 'node:22',
  needs: [],
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

const loaded = blocksListReducer(initialBlocksList, {
  type: 'loaded',
  blocks: [
    block({ id: '1' }),
    block({
      id: '2',
      key: 'deploy-systemd',
      name: 'Deploy with systemd',
      description: null,
      kind: 'deploy',
      runsOn: 'target',
      image: null,
      latestVersion: 1,
      hasDraft: true,
      needs: ['DEPLOY_TOKEN (secured)'],
    }),
    block({
      id: '3',
      key: 'wip',
      name: 'Work in progress',
      kind: 'check',
      latestVersion: 0,
      hasDraft: true,
      runsOn: null,
    }),
  ],
});

describe('the building blocks list', () => {
  it('reads each block as a row: kind, where it runs, what it needs, its version', () => {
    expect(visibleRows(loaded)).toEqual([
      {
        id: '1',
        name: 'Node: install, lint, test',
        about: 'npm ci, lint, test',
        kind: 'Test',
        runsOn: 'Hosted runner · node:22',
        needs: '—',
        version: 'v4',
      },
      {
        id: '2',
        name: 'Deploy with systemd',
        about: 'deploy-systemd',
        kind: 'Deploy',
        runsOn: 'A target a pipeline picks',
        needs: 'DEPLOY_TOKEN (secured)',
        version: 'v1 · unpublished changes',
      },
      {
        id: '3',
        name: 'Work in progress',
        about: 'npm ci, lint, test',
        kind: 'Checks',
        runsOn: '—',
        needs: '—',
        version: 'Draft',
      },
    ]);
  });

  it('narrows to a kind, then to words in the name, description or key', () => {
    expect(
      visibleRows(blocksListReducer(loaded, { type: 'kind', kind: 'deploy' })).map((r) => r.id)
    ).toEqual(['2']);
    expect(
      visibleRows(blocksListReducer(loaded, { type: 'query', query: 'SYSTEMD' })).map((r) => r.id)
    ).toEqual(['2']);
    const nothing = blocksListReducer(loaded, { type: 'query', query: 'terraform' });
    expect(emptyLine(nothing)).toBe('No block matches.');
  });

  it('says how to start when the catalogue is empty, and nothing while it loads', () => {
    expect(emptyLine(initialBlocksList)).toBeNull();
    expect(emptyLine(blocksListReducer(initialBlocksList, { type: 'loaded', blocks: [] }))).toBe(
      'No building blocks yet. Start one, or draft one with AI.'
    );
  });
});
