/**
 * The MCP route tells clients `tools.listChanged: false`, and that has to
 * STAY false. The SDK turns the bit on the moment a tool is registered —
 * `registerCapabilities({ tools: { listChanged: existing ?? true } })` — so
 * the route's explicit `false` is the only thing holding it down.
 *
 * This pins SDK behaviour rather than our own code on purpose: if an upgrade
 * changes that `??` to an unconditional `true`, the server silently goes back
 * to promising notifications it never sends, and the only symptom is a client
 * that caches its tool list forever. That one took a long time to find.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

function serverWith(capabilities: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: 'test', version: '1' }, { capabilities });
  server.registerTool('a_tool', { description: 'a tool', inputSchema: z.object({}) }, async () => ({
    content: [],
  }));
  return server;
}

describe('tools.listChanged', () => {
  it('stays false when the route asks for false', () => {
    const server = serverWith({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
    expect(server.server.getCapabilities().tools?.listChanged).toBe(false);
  });

  it('defaults to true — which is why the route must be explicit', () => {
    const server = serverWith({});
    expect(server.server.getCapabilities().tools?.listChanged).toBe(true);
  });
});
