import {
  canFetchDefinition,
  fabricBrowserReducer,
  filterCounts,
  initialFabricBrowser,
  selectedWorkspace,
  startRequestBody,
  visibleItems,
  type FabricBrowserAction,
  type FabricBrowserState,
  type ItemRow,
} from './fabric-browser.model';

const fold = (...actions: FabricBrowserAction[]): FabricBrowserState =>
  actions.reduce(fabricBrowserReducer, initialFabricBrowser);

const workspaces = [
  { id: 'ws-sales', displayName: 'Sales', type: 'Workspace', capacityId: 'cap' },
  { id: 'ws-ops', displayName: 'Ops', type: 'Workspace', capacityId: '' },
];
const item = (id: string, displayName: string, type: string): ItemRow => ({
  id,
  displayName,
  type,
  description: '',
});
const items = [
  item('r1', 'Revenue', 'Report'),
  item('lh1', 'Bronze', 'Lakehouse'),
  item('nb2', 'Train model', 'Notebook'),
  item('pl1', 'Nightly', 'DataPipeline'),
  item('nb1', 'Load orders', 'Notebook'),
];

const opened = (...more: FabricBrowserAction[]) =>
  fold(
    { type: 'workspacesLoaded', workspaces },
    { type: 'workspaceChosen', workspaceId: 'ws-sales' },
    { type: 'itemsLoaded', workspaceId: 'ws-sales', items },
    ...more
  );

describe('the Fabric page', () => {
  it('opens on the workspaces loading, with nothing chosen', () => {
    expect(initialFabricBrowser.workspaces.status).toBe('loading');
    expect(selectedWorkspace(initialFabricBrowser)).toBeNull();
  });

  it('lists a workspace’s notebooks first, then pipelines, then lakehouses, then the rest, by name', () => {
    expect(visibleItems(opened()).map((i) => i.displayName)).toEqual([
      'Load orders',
      'Train model',
      'Nightly',
      'Bronze',
      'Revenue',
    ]);
  });

  it('a filter keeps one kind and the counts say how many of each there are', () => {
    const state = opened({ type: 'filterChosen', filter: 'Notebook' });
    expect(visibleItems(state).map((i) => i.id)).toEqual(['nb1', 'nb2']);
    expect(filterCounts(state)).toEqual({ all: 5, Notebook: 2, DataPipeline: 1, Lakehouse: 1 });
  });

  it('an answer for a workspace the person has since left is dropped', () => {
    const state = fold(
      { type: 'workspacesLoaded', workspaces },
      { type: 'workspaceChosen', workspaceId: 'ws-sales' },
      { type: 'workspaceChosen', workspaceId: 'ws-ops' },
      { type: 'itemsLoaded', workspaceId: 'ws-sales', items }
    );
    expect(state.items.status).toBe('loading');
    expect(selectedWorkspace(state)?.displayName).toBe('Ops');
  });

  it('switching workspace closes the tables that were open', () => {
    const state = opened(
      { type: 'tablesRequested', lakehouseId: 'lh1' },
      { type: 'workspaceChosen', workspaceId: 'ws-ops' }
    );
    expect(state.tables).toBeNull();
  });

  it('a lakehouse’s tables show once loaded; a late answer for another lakehouse is dropped', () => {
    const tables = [{ name: 'orders', type: 'Managed', format: 'Delta', location: 'abfss://…' }];
    const state = opened(
      { type: 'tablesRequested', lakehouseId: 'lh1' },
      { type: 'tablesLoaded', lakehouseId: 'lh-other', tables: [] },
      { type: 'tablesLoaded', lakehouseId: 'lh1', tables }
    );
    expect(state.tables).toEqual({ lakehouseId: 'lh1', load: { status: 'ready', list: tables } });
  });

  it('offers a definition on notebooks and pipelines only, and one fetch at a time', () => {
    const state = opened();
    expect(canFetchDefinition(state, items[4])).toBe(true);
    expect(canFetchDefinition(state, items[3])).toBe(true);
    expect(canFetchDefinition(state, items[1])).toBe(false);
    const starting = opened({ type: 'definitionRequested', itemId: 'nb1' });
    expect(canFetchDefinition(starting, items[3])).toBe(false);
  });

  it('starting a fetch sends the kind, the ids and the names the operation page shows', () => {
    expect(startRequestBody(opened(), items[4])).toEqual({
      kind: 'notebook-definition',
      workspaceId: 'ws-sales',
      workspaceName: 'Sales',
      itemId: 'nb1',
      itemName: 'Load orders',
    });
    expect(startRequestBody(opened(), items[1])).toBeNull();
  });

  it('a refused fetch frees the button and says why beside that item', () => {
    const state = opened(
      { type: 'definitionRequested', itemId: 'nb1' },
      { type: 'definitionFailed', itemId: 'nb1', error: 'Fabric refused (403)' }
    );
    expect(state.starting).toBeNull();
    expect(state.startError).toEqual({ itemId: 'nb1', error: 'Fabric refused (403)' });
  });
});
