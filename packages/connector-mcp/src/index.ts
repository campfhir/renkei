/**
 * @renkei/connector-mcp — remote MCP servers as connectors: the pure
 * vocabulary (`pure.ts`), a client for both remote transports (`client.ts`),
 * and the data-store accessors for the admin's server list and each person's cached
 * tool list (`store.ts`). Authorization is the server's own; tokens live in
 * the delegate, so nothing here ever holds one.
 */

export * from './pure';
export * from './client';
export * from './store';
