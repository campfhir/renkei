import {
  cardButtons,
  init,
  listsOnFirstSight,
  loadsOnToggle,
  reducer,
  statusBadge,
  toolList,
  transportLabel,
  type McpServerCardAction,
  type McpServerCardState,
  type McpServerView,
} from './mcp-servers-list.model';

function server(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 'srv-1',
    slug: 'acme_docs',
    name: 'Acme Docs',
    host: 'mcp.acme.test',
    transport: 'streamable_http',
    authMode: 'oauth',
    context: 'Insurance policies.',
    connected: false,
    toolCount: 0,
    ...overrides,
  };
}

const LOOKUP = { name: 'lookup_policy', description: 'Look up a policy.', readOnly: true };
const FILE = { name: 'file_claim', description: '', readOnly: false };

const fold = (state: McpServerCardState, ...actions: McpServerCardAction[]) =>
  actions.reduce(reducer, state);

describe('an MCP server card: badges', () => {
  it('names the transport: SSE for the legacy one, Streamable HTTP otherwise', () => {
    expect(transportLabel(server({ transport: 'sse' }))).toBe('SSE');
    expect(transportLabel(server())).toBe('Streamable HTTP');
  });

  it('shows no status before the person connects a server that signs them in', () => {
    expect(statusBadge(server())).toBeNull();
  });

  it('shows "connected" once they have', () => {
    expect(statusBadge(server({ connected: true }))).toBe('connected');
  });

  it('shows "open" for a server without sign-in, connected or not', () => {
    expect(statusBadge(server({ authMode: 'none' }))).toBe('open');
  });
});

describe('an MCP server card: buttons', () => {
  it('offers only Connect, at the server’s authorize route, before a sign-in server is connected', () => {
    expect(cardButtons(init(server()))).toEqual({
      kind: 'connect',
      href: '/api/mcp-servers/srv-1/authorize',
    });
  });

  it('offers the tools, a refresh and Disconnect once connected', () => {
    expect(cardButtons(init(server({ connected: true, toolCount: 2 })))).toEqual({
      kind: 'usable',
      toolsLabel: 'Tools (2)',
      refreshLabel: 'Refresh tools',
      disconnect: true,
    });
  });

  it('offers no Connect and no Disconnect on an open server', () => {
    expect(cardButtons(init(server({ authMode: 'none', toolCount: 2 })))).toEqual({
      kind: 'usable',
      toolsLabel: 'Tools (2)',
      refreshLabel: 'Refresh tools',
      disconnect: false,
    });
  });

  it('says Working… while a refresh is out, and Hide tools while the list is open', () => {
    const state = fold(
      init(server({ connected: true })),
      { type: 'toolsToggled' },
      {
        type: 'refreshStarted',
      }
    );
    expect(cardButtons(state)).toMatchObject({
      toolsLabel: 'Hide tools',
      refreshLabel: 'Working…',
    });
    expect(state.busy).toBe(true);
  });
});

describe('an MCP server card: the tool list', () => {
  it('asks an open server for its tools the first time the card shows, when none are listed', () => {
    expect(listsOnFirstSight(server({ authMode: 'none' }))).toBe(true);
    expect(listsOnFirstSight(server({ authMode: 'none', toolCount: 2 }))).toBe(false);
    expect(listsOnFirstSight(server({ connected: true }))).toBe(false);
  });

  it('a first look at an open server lists its tools without unfolding them', () => {
    const state = fold(
      init(server({ authMode: 'none' })),
      { type: 'refreshStarted' },
      { type: 'refreshed', tools: [LOOKUP, FILE], reveal: false }
    );
    expect(state.open).toBe(false);
    expect(cardButtons(state)).toMatchObject({ toolsLabel: 'Tools (2)' });
    expect(state.server.connected).toBe(false);
  });

  it('unfolding the list the first time loads it, and shows loading until it arrives', () => {
    const start = init(server({ connected: true, toolCount: 2 }));
    expect(loadsOnToggle(start)).toBe(true);
    const opened = fold(start, { type: 'toolsToggled' });
    expect(toolList(opened)).toEqual({ kind: 'loading' });
    const loaded = fold(opened, { type: 'toolsLoaded', tools: [LOOKUP, FILE] });
    expect(toolList(loaded)).toEqual({
      kind: 'tools',
      tools: [
        {
          key: 'lookup_policy',
          name: 'acme_docs__lookup_policy',
          access: 'read',
          description: 'Look up a policy.',
        },
        { key: 'file_claim', name: 'acme_docs__file_claim', access: 'act', description: '' },
      ],
    });
  });

  it('folding and unfolding again does not ask again', () => {
    const state = fold(
      init(server({ connected: true })),
      { type: 'toolsToggled' },
      { type: 'toolsLoaded', tools: [LOOKUP] },
      { type: 'toolsToggled' }
    );
    expect(state.open).toBe(false);
    expect(loadsOnToggle(state)).toBe(false);
  });

  it('says so when the server lists no tools for the person', () => {
    const state = fold(
      init(server({ connected: true })),
      { type: 'toolsToggled' },
      {
        type: 'toolsLoaded',
        tools: [],
      }
    );
    expect(toolList(state)).toEqual({ kind: 'empty' });
  });

  it('a list that cannot be read shows why', () => {
    const state = fold(
      init(server({ connected: true })),
      { type: 'toolsToggled' },
      {
        type: 'toolsLoadFailed',
        error: 'Database error',
      }
    );
    expect(state.error).toBe('Database error');
  });
});

describe('an MCP server card: refresh', () => {
  it('a refresh shows the new list, counts it and opens it', () => {
    const state = fold(
      init(server({ connected: true, toolCount: 2 })),
      { type: 'refreshStarted' },
      { type: 'refreshed', tools: [LOOKUP, FILE, { ...LOOKUP, name: 'third' }], reveal: true }
    );
    expect(state.open).toBe(true);
    expect(state.busy).toBe(false);
    expect(cardButtons(state)).toMatchObject({ toolsLabel: 'Hide tools' });
    expect(state.server.toolCount).toBe(3);
  });

  it('a server that answers a sign-in server’s refresh has the person connected', () => {
    const state = fold(init(server()), { type: 'refreshed', tools: [LOOKUP], reveal: true });
    expect(state.server.connected).toBe(true);
    expect(statusBadge(state.server)).toBe('connected');
  });

  it('a refused refresh keeps the list it had and shows why, or that the server did not answer', () => {
    const listed = fold(init(server({ connected: true, toolCount: 1 })), {
      type: 'refreshed',
      tools: [LOOKUP],
      reveal: false,
    });
    const refused = fold(
      listed,
      { type: 'refreshStarted' },
      {
        type: 'refreshFailed',
        error: 'Connect this server again.',
      }
    );
    expect(refused).toMatchObject({ busy: false, error: 'Connect this server again.' });
    expect(refused.tools).toEqual([LOOKUP]);

    const silent = fold(listed, { type: 'refreshStarted' }, { type: 'refreshFailed', error: null });
    expect(silent.error).toBe('The server did not answer.');
  });

  it('a new press clears the last error', () => {
    const state = fold(
      init(server({ connected: true })),
      { type: 'refreshFailed', error: 'nope' },
      { type: 'refreshStarted' }
    );
    expect(state.error).toBeNull();
  });
});

describe('an MCP server card: disconnect', () => {
  it('Disconnect ends the grant: back to Connect, the list folded and forgotten', () => {
    const state = fold(
      init(server({ connected: true, toolCount: 2 })),
      { type: 'toolsToggled' },
      { type: 'toolsLoaded', tools: [LOOKUP, FILE] },
      { type: 'disconnectStarted' },
      { type: 'disconnected' }
    );
    expect(state).toMatchObject({ open: false, tools: null, busy: false });
    expect(state.server).toMatchObject({ connected: false, toolCount: 0 });
    expect(cardButtons(state).kind).toBe('connect');
    expect(statusBadge(state.server)).toBeNull();
  });

  it('a refused disconnect stays connected and shows why', () => {
    const state = fold(
      init(server({ connected: true, toolCount: 2 })),
      { type: 'disconnectStarted' },
      { type: 'disconnectFailed', error: 'Could not disconnect' }
    );
    expect(state).toMatchObject({ busy: false, error: 'Could not disconnect' });
    expect(statusBadge(state.server)).toBe('connected');
  });
});
