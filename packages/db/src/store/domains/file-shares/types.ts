/**
 * A network file share an admin registered, as stored. `protocol` is the
 * stored string (@renkei/connector-fileshares validates it).
 */
export interface FileShareRecord {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  shareName: string | null;
  rootPath: string;
  caseInsensitive: boolean;
  enabled: boolean;
  hostKeyFingerprint: string | null;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** One person's connection to a share: the account, the exposure choice, the sealed credential. */
export interface FileShareConnectionRecord {
  username: string;
  toolAccess: string;
  allowDelete: boolean;
  /** As stored; only the worker (through the delegate) opens it. */
  encryptedCredentials: string;
}

export interface FileShareInput {
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  shareName: string | null;
  rootPath: string;
  caseInsensitive: boolean;
  enabled: boolean;
  hostKeyFingerprint: string | null;
}

export interface FileShareStore {
  /**
   * Every enabled share by name, each with THIS person's connection or
   * null — the connectors page, and what the tools list.
   */
  listWithConnection(
    subject: string
  ): Promise<{ share: FileShareRecord; connection: FileShareConnectionRecord | null }[]>;
  getConnection(shareId: string, subject: string): Promise<FileShareConnectionRecord | null>;
  /** Store or replace this person's connection to a share. */
  upsertConnection(
    shareId: string,
    subject: string,
    connection: FileShareConnectionRecord
  ): Promise<void>;
  /** Change only the exposure choice; returns how many rows changed. */
  updateConnectionExposure(
    shareId: string,
    subject: string,
    exposure: { toolAccess: string; allowDelete: boolean }
  ): Promise<number>;
  deleteConnection(shareId: string, subject: string): Promise<number>;
  /** This person's exposure choices on enabled shares, by share id. */
  connectionExposures(subject: string): Promise<{ toolAccess: string; allowDelete: boolean }[]>;
  /** Every share, enabled or not, by name. */
  list(): Promise<FileShareRecord[]>;
  get(id: string): Promise<FileShareRecord | null>;
  /** Returns the new id; rejects with 23505 when the name is taken. */
  create(share: FileShareInput): Promise<string>;
  /** Returns how many rows changed; rejects with 23505 when the name is taken. */
  update(id: string, share: FileShareInput): Promise<number>;
  /** Pin a host key only where none is pinned yet; returns how many rows changed. */
  recordHostKeyFingerprint(id: string, fingerprint: string): Promise<number>;
  /** Deletes the share and every connection to it; returns how many shares went. */
  delete(id: string): Promise<number>;
}
