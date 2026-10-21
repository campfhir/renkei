/**
 * The "MCP servers" card — the remote servers the organization lists. Each
 * row is one server: connect signs the person in AT that server (the server
 * owns authorization), and what it then offers is whatever it lists for
 * that person. This file owns the static heading; the rows are a client
 * island (`McpServersList`) because each manages its own connect, refresh
 * and disconnect state.
 */

import ConnectorIcon from '@/components/connector-icon';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import McpServersList, { type McpServerView } from './mcp-servers-list';

export type { McpServerView } from './mcp-servers-list';

export default function McpServersConnector({ servers }: { servers: McpServerView[] }) {
  return (
    <ConnectorShell>
      <ConnectorHeading>
        <ConnectorIcon capabilityKey="mcp" label="MCP servers" size={20} />
        MCP servers
      </ConnectorHeading>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Servers your organization offers. Each one signs you in itself, and what you can reach is
        what it lists for your account. In chat, ask for the server by name — Renkei finds its tools
        for you.
      </p>
      <McpServersList servers={servers} />
    </ConnectorShell>
  );
}
