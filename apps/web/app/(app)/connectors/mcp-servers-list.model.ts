/**
 * One remote MCP server's card on the Connectors page (mcp-servers-list.tsx):
 * its badges, which buttons it offers, and what each answer from the
 * server's routes leaves on it.
 *
 * A server that signs people in (`oauth`) offers Connect until the person
 * has connected; an open one (`none`) is usable at once, and since it has
 * no connect step to list its tools after, the card asks for them the
 * first time it is seen (`listsOnFirstSight`). The component makes the
 * calls (GET and POST …/tools, DELETE …/grant) and dispatches the answers.
 */

export interface McpServerView {
  id: string;
  slug: string;
  name: string;
  host: string;
  transport: 'streamable_http' | 'sse';
  authMode: 'oauth' | 'none';
  context: string;
  connected: boolean;
  toolCount: number;
}

export interface ToolView {
  name: string;
  description: string;
  readOnly: boolean;
}

export interface McpServerCardState {
  server: McpServerView;
  /** The person's tools on the server; null until asked for. */
  tools: ToolView[] | null;
  /** The tool list is unfolded. */
  open: boolean;
  /** A refresh or a disconnect is in flight. */
  busy: boolean;
  error: string | null;
}

export type McpServerCardAction =
  | { type: 'toolsToggled' }
  | { type: 'toolsLoaded'; tools: ToolView[] }
  | { type: 'toolsLoadFailed'; error: string }
  | { type: 'refreshStarted' }
  | { type: 'refreshed'; tools: ToolView[]; reveal: boolean }
  | { type: 'refreshFailed'; error: string | null }
  | { type: 'disconnectStarted' }
  | { type: 'disconnected' }
  | { type: 'disconnectFailed'; error: string };

export function init(server: McpServerView): McpServerCardState {
  return { server, tools: null, open: false, busy: false, error: null };
}

export function reducer(
  state: McpServerCardState,
  action: McpServerCardAction
): McpServerCardState {
  switch (action.type) {
    case 'toolsToggled':
      return { ...state, open: !state.open };
    case 'toolsLoaded':
      return { ...state, tools: action.tools };
    case 'toolsLoadFailed':
      return { ...state, error: action.error };
    case 'refreshStarted':
    case 'disconnectStarted':
      return { ...state, busy: true, error: null };
    case 'refreshed':
      return {
        ...state,
        busy: false,
        tools: action.tools,
        // The server answered with this person's tools: whatever it signs
        // people in with, they are connected now.
        server: {
          ...state.server,
          toolCount: action.tools.length,
          connected: state.server.authMode === 'oauth' ? true : state.server.connected,
        },
        open: action.reveal ? true : state.open,
      };
    case 'refreshFailed':
      return { ...state, busy: false, error: action.error ?? 'The server did not answer.' };
    case 'disconnected':
      return {
        ...state,
        busy: false,
        tools: null,
        open: false,
        server: { ...state.server, connected: false, toolCount: 0 },
      };
    case 'disconnectFailed':
      return { ...state, busy: false, error: action.error };
  }
}

/** Unfolding the list for the first time asks the server's route for it. */
export function loadsOnToggle(state: McpServerCardState): boolean {
  return !state.open && state.tools === null;
}

/** An open server with nothing listed yet is asked for its tools when the card first shows. */
export function listsOnFirstSight(server: McpServerView): boolean {
  return server.authMode === 'none' && server.toolCount === 0;
}

/** The person can use the server: it is open, or they have connected. */
export function usable(server: McpServerView): boolean {
  return server.authMode === 'none' || server.connected;
}

/** The transport badge. */
export function transportLabel(server: McpServerView): string {
  return server.transport === 'sse' ? 'SSE' : 'Streamable HTTP';
}

/** The green badge: "open" for a server without sign-in, "connected" once signed in, else none. */
export function statusBadge(server: McpServerView): 'open' | 'connected' | null {
  if (!usable(server)) return null;
  return server.authMode === 'none' ? 'open' : 'connected';
}

/** The buttons the card offers: Connect, or the tools, a refresh and (when signed in) Disconnect. */
export function cardButtons(
  state: McpServerCardState
):
  | { kind: 'connect'; href: string }
  | { kind: 'usable'; toolsLabel: string; refreshLabel: string; disconnect: boolean } {
  const { server } = state;
  if (!usable(server)) return { kind: 'connect', href: `/api/mcp-servers/${server.id}/authorize` };
  return {
    kind: 'usable',
    toolsLabel: state.open ? 'Hide tools' : `Tools (${server.toolCount})`,
    refreshLabel: state.busy ? 'Working…' : 'Refresh tools',
    disconnect: server.authMode === 'oauth',
  };
}

/** What the unfolded list shows: loading, the empty line, or each tool as the model will see it. */
export function toolList(state: McpServerCardState):
  | { kind: 'loading' }
  | { kind: 'empty' }
  | {
      kind: 'tools';
      tools: { key: string; name: string; access: 'read' | 'act'; description: string }[];
    } {
  if (state.tools === null) return { kind: 'loading' };
  if (state.tools.length === 0) return { kind: 'empty' };
  return {
    kind: 'tools',
    tools: state.tools.map((tool) => ({
      key: tool.name,
      name: `${state.server.slug}__${tool.name}`,
      access: tool.readOnly ? 'read' : 'act',
      description: tool.description,
    })),
  };
}
