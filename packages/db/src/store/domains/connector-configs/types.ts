/**
 * One connector's org configuration, as stored. `encryptedSecrets` is the
 * sealed envelope exactly as written; opening it is the caller's
 * (@renkei/connector-config), never the store's.
 */
export interface ConnectorConfigRecord {
  connector: string;
  enabled: boolean;
  /** The inspectable, non-secret jsonb, parsed. */
  settings: unknown;
  encryptedSecrets: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorConfigStore {
  get(connector: string): Promise<ConnectorConfigRecord | null>;
  /** Every connector's row by connector key, or only the enabled ones. */
  list(options?: { enabledOnly?: boolean }): Promise<ConnectorConfigRecord[]>;
  /** Insert or replace one connector's row; `createdAt` is kept on replace. */
  upsert(config: {
    connector: string;
    enabled: boolean;
    settings: unknown;
    encryptedSecrets: string;
  }): Promise<void>;
}
