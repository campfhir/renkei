/** A Mirth Connect server an operator registered, as stored. */
export interface MirthInstanceRecord {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  caPem: string | null;
  allowInsecureHttp: boolean;
  enabled: boolean;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** One person's connection to an instance: account, exposure choice, sealed credential. */
export interface MirthConnectionRecord {
  username: string;
  permissions: string[];
  /** As stored; only the worker (through the delegate) opens it. */
  encryptedCredentials: string;
}

export interface MirthInstanceInput {
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  /** Null clears a pinned CA; undefined keeps whatever is stored (on update). */
  caPem: string | null | undefined;
  allowInsecureHttp: boolean;
  enabled: boolean;
}

export interface MirthInstanceStore {
  /** Every enabled instance by name, each with THIS person's connection or null. */
  listWithConnection(
    subject: string
  ): Promise<{ instance: MirthInstanceRecord; connection: MirthConnectionRecord | null }[]>;
  getConnection(instanceId: string, subject: string): Promise<MirthConnectionRecord | null>;
  upsertConnection(
    instanceId: string,
    subject: string,
    connection: MirthConnectionRecord
  ): Promise<void>;
  /** Change only the permissions; returns how many rows changed. */
  updateConnectionPermissions(
    instanceId: string,
    subject: string,
    permissions: string[]
  ): Promise<number>;
  deleteConnection(instanceId: string, subject: string): Promise<number>;
  /** This person's permission lists on enabled instances, by instance id. */
  connectionPermissions(subject: string): Promise<string[][]>;
  /** Every instance, enabled or not, by name. */
  list(): Promise<MirthInstanceRecord[]>;
  get(id: string): Promise<MirthInstanceRecord | null>;
  /** Returns the new id; rejects with 23505 when the name is taken. */
  create(instance: MirthInstanceInput): Promise<string>;
  /** Returns how many rows changed; rejects with 23505 when the name is taken. */
  update(id: string, instance: MirthInstanceInput): Promise<number>;
  /** Deletes the instance and every connection to it; returns how many went. */
  delete(id: string): Promise<number>;
}
