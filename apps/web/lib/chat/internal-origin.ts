/**
 * Where this process reaches its own MCP endpoint. The agents worker has
 * always been told with RENKEI_WEB_INTERNAL_URL; the web app calling
 * itself defaults to loopback on its own port, so a bare `pnpm dev` works
 * without configuration and a container needs nothing beyond what the
 * compose file already sets.
 */

export function internalMcpEndpoint(tenantId: string): string {
  const configured = (process.env.RENKEI_WEB_INTERNAL_URL ?? '').trim().replace(/\/+$/, '');
  const base = configured || `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
  return `${base}/api/mcp/${tenantId}/mcp`;
}
