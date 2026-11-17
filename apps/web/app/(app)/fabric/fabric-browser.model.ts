/**
 * The Fabric page's state (fabric-browser.tsx): the person's workspaces,
 * the one they opened and what is in it, a lakehouse's tables when asked
 * for, and a definition fetch being started.
 *
 * The component makes the calls and dispatches what the person did and
 * what the server answered; what the page decides from that — which items
 * show under a filter, which can have their definition fetched, what the
 * start request sends, that an answer for a workspace no longer open is
 * dropped — is here, and tested in fabric-browser.model.test.ts.
 */

export interface WorkspaceRow {
  id: string;
  displayName: string;
  type: string;
  capacityId: string;
}

export interface ItemRow {
  id: string;
  displayName: string;
  description: string;
  type: string;
}

export interface TableRow {
  name: string;
  type: string;
  format: string;
  location: string;
}

type Load<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; list: T[] }
  | { status: 'failed'; error: string };

export type ItemFilter = 'all' | 'Notebook' | 'DataPipeline' | 'Lakehouse';

export interface FabricBrowserState {
  workspaces: Load<WorkspaceRow>;
  workspaceId: string | null;
  items: Load<ItemRow>;
  filter: ItemFilter;
  /** The lakehouse whose tables are open, and them. */
  tables: { lakehouseId: string; load: Load<TableRow> } | null;
  /** The item whose definition fetch is being started. */
  starting: string | null;
  startError: { itemId: string; error: string } | null;
}

export type FabricBrowserAction =
  | { type: 'workspacesLoaded'; workspaces: WorkspaceRow[] }
  | { type: 'workspacesFailed'; error: string }
  | { type: 'workspaceChosen'; workspaceId: string }
  | { type: 'itemsLoaded'; workspaceId: string; items: ItemRow[] }
  | { type: 'itemsFailed'; workspaceId: string; error: string }
  | { type: 'filterChosen'; filter: ItemFilter }
  | { type: 'tablesRequested'; lakehouseId: string }
  | { type: 'tablesClosed' }
  | { type: 'tablesLoaded'; lakehouseId: string; tables: TableRow[] }
  | { type: 'tablesFailed'; lakehouseId: string; error: string }
  | { type: 'definitionRequested'; itemId: string }
  /** The fetch started; the page moves to the operation, so nothing is kept. */
  | { type: 'definitionStarted'; itemId: string }
  | { type: 'definitionFailed'; itemId: string; error: string };

export const initialFabricBrowser: FabricBrowserState = {
  workspaces: { status: 'loading' },
  workspaceId: null,
  items: { status: 'idle' },
  filter: 'all',
  tables: null,
  starting: null,
  startError: null,
};

export function fabricBrowserReducer(
  state: FabricBrowserState,
  action: FabricBrowserAction
): FabricBrowserState {
  switch (action.type) {
    case 'workspacesLoaded':
      return { ...state, workspaces: { status: 'ready', list: action.workspaces } };
    case 'workspacesFailed':
      return { ...state, workspaces: { status: 'failed', error: action.error } };
    case 'workspaceChosen':
      if (action.workspaceId === state.workspaceId) return state;
      return {
        ...state,
        workspaceId: action.workspaceId,
        items: { status: 'loading' },
        tables: null,
        starting: null,
        startError: null,
      };
    case 'itemsLoaded':
      // An answer for a workspace the person has since left is dropped.
      if (action.workspaceId !== state.workspaceId) return state;
      return { ...state, items: { status: 'ready', list: action.items } };
    case 'itemsFailed':
      if (action.workspaceId !== state.workspaceId) return state;
      return { ...state, items: { status: 'failed', error: action.error } };
    case 'filterChosen':
      return { ...state, filter: action.filter };
    case 'tablesRequested':
      return { ...state, tables: { lakehouseId: action.lakehouseId, load: { status: 'loading' } } };
    case 'tablesClosed':
      return { ...state, tables: null };
    case 'tablesLoaded':
      if (state.tables?.lakehouseId !== action.lakehouseId) return state;
      return {
        ...state,
        tables: { lakehouseId: action.lakehouseId, load: { status: 'ready', list: action.tables } },
      };
    case 'tablesFailed':
      if (state.tables?.lakehouseId !== action.lakehouseId) return state;
      return {
        ...state,
        tables: {
          lakehouseId: action.lakehouseId,
          load: { status: 'failed', error: action.error },
        },
      };
    case 'definitionRequested':
      if (state.starting) return state;
      return { ...state, starting: action.itemId, startError: null };
    case 'definitionStarted':
      return state.starting === action.itemId ? { ...state, starting: null } : state;
    case 'definitionFailed':
      return {
        ...state,
        starting: state.starting === action.itemId ? null : state.starting,
        startError: { itemId: action.itemId, error: action.error },
      };
  }
}

/** The definition a kind of item has, or null when Renkei cannot fetch one. */
export function definitionKindOf(
  item: Pick<ItemRow, 'type'>
): 'notebook-definition' | 'pipeline-definition' | null {
  if (item.type === 'Notebook') return 'notebook-definition';
  if (item.type === 'DataPipeline') return 'pipeline-definition';
  return null;
}

export function selectedWorkspace(state: FabricBrowserState): WorkspaceRow | null {
  if (state.workspaces.status !== 'ready' || !state.workspaceId) return null;
  return state.workspaces.list.find((w) => w.id === state.workspaceId) ?? null;
}

/** The items the filter keeps: notebooks, then pipelines, then lakehouses, then the rest; by name within. */
export function visibleItems(state: FabricBrowserState): ItemRow[] {
  if (state.items.status !== 'ready') return [];
  const rank = (type: string) => {
    const index = ['Notebook', 'DataPipeline', 'Lakehouse'].indexOf(type);
    return index === -1 ? 3 : index;
  };
  return state.items.list
    .filter((item) => state.filter === 'all' || item.type === state.filter)
    .sort(
      (a, b) =>
        rank(a.type) - rank(b.type) ||
        a.type.localeCompare(b.type) ||
        a.displayName.localeCompare(b.displayName)
    );
}

/** How many of each filterable kind the open workspace holds. */
export function filterCounts(state: FabricBrowserState): Record<ItemFilter, number> {
  const list = state.items.status === 'ready' ? state.items.list : [];
  const count = (type: string) => list.filter((item) => item.type === type).length;
  return {
    all: list.length,
    Notebook: count('Notebook'),
    DataPipeline: count('DataPipeline'),
    Lakehouse: count('Lakehouse'),
  };
}

/** Whether "Get definition" is offered on an item right now. */
export function canFetchDefinition(state: FabricBrowserState, item: ItemRow): boolean {
  return definitionKindOf(item) !== null && state.starting === null;
}

/** What starting a definition fetch sends (POST /api/fabric/operations); null when it cannot. */
export function startRequestBody(
  state: FabricBrowserState,
  item: ItemRow
): Record<string, string> | null {
  const kind = definitionKindOf(item);
  const workspace = selectedWorkspace(state);
  if (!kind || !workspace) return null;
  return {
    kind,
    workspaceId: workspace.id,
    workspaceName: workspace.displayName,
    itemId: item.id,
    itemName: item.displayName,
  };
}
