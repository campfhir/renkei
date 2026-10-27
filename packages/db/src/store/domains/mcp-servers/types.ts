/**
 * A remote MCP server an admin registered, as stored. `transport` and
 * `authMode` are the stored strings (@renkei/connector-mcp narrows them);
 * `encryptedClientSecret` is the sealed secret exactly as written.
 */
export interface McpServerRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: string;
  authMode: string;
  context: string;
  oauth: unknown;
  clientId: string | null;
  encryptedClientSecret: string | null;
  scopes: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMcpServerRecord {
  slug: string;
  name: string;
  url: string;
  transport: string;
  authMode: string;
  context: string;
  scopes: string | null;
  clientId: string | null;
  encryptedClientSecret: string | null;
  enabled: boolean;
}

/** Fields to change; undefined keeps the stored value, null clears a nullable one. */
export interface McpServerPatch {
  name?: string;
  url?: string;
  transport?: string;
  authMode?: string;
  context?: string;
  scopes?: string | null;
  enabled?: boolean;
  clientId?: string | null;
  encryptedClientSecret?: string | null;
  oauth?: unknown;
}

/** One person's cached tool list for one server, as stored (parsed JSON). */
export interface McpToolListRecord {
  serverId: string;
  tools: unknown;
  fetchedAt: Date;
}

export interface McpServerStore {
  /** Every server, by name (ties by id). */
  list(): Promise<McpServerRecord[]>;
  get(id: string): Promise<McpServerRecord | null>;
  getBySlug(slug: string): Promise<McpServerRecord | null>;
  /** Rejects with 23505 when the slug is taken. */
  create(server: NewMcpServerRecord): Promise<McpServerRecord>;
  /** Applies the patch and touches `updatedAt`; null when there is no such server. */
  update(id: string, patch: McpServerPatch): Promise<McpServerRecord | null>;
  /** Deletes the server (its cached tool lists go with it); returns how many went. */
  delete(id: string): Promise<number>;
  /** Insert or replace this person's list for a server, stamped now. */
  saveToolList(serverId: string, subject: string, tools: unknown): Promise<void>;
  /** This person's lists for every server, by server id. */
  listToolLists(subject: string): Promise<McpToolListRecord[]>;
  /** Forget everyone's lists for a server (its address or sign-in changed); returns how many went. */
  clearToolListsForServer(serverId: string): Promise<number>;
  /** Forget this person's list for a server; returns how many went. */
  clearToolList(serverId: string, subject: string): Promise<number>;
}
