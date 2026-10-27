/**
 * Resource data keys at rest (resource_keys, resource_key_grants;
 * migrations 133, 138): one key row per resource and its wrappings, each
 * under some holder's key. Everything is stored and returned as
 * ciphertext — @renkei/user-keys mints, wraps and opens.
 */

/** One wrapping of a key, as stored. */
export interface ResourceKeyWrappingRecord {
  resourceKeyId: string;
  /** user | automation | public | resource */
  holderKind: string;
  /** A subject, or (for `resource`) the parent key's id. */
  holder: string;
  wrappedKey: string;
}

export interface ResourceKeyWrappingInput {
  resourceKeyId: string;
  holderKind: string;
  holder: string;
  wrappedKey: string;
  kekVersion: number;
  grantedBy: string | null;
}

/** Who holds a wrapping, without the wrapping. */
export interface ResourceKeyHolderRecord {
  holderKind: string;
  holder: string;
  grantedBy: string | null;
  kekVersion: number;
}

export interface ResourceKeyStore {
  /** The key row's id for a resource, or null when it has none. */
  find(kind: string, resourceId: string): Promise<string | null>;
  /** The key ids of those of these resources that have one, by resource id (ties by key id). */
  findMany(kind: string, resourceIds: string[]): Promise<{ id: string; resourceId: string }[]>;
  /** A key row for the resource unless one exists: the new id, or null when one was there. */
  insertIfAbsent(kind: string, resourceId: string): Promise<string | null>;
  /** Delete a resource's key row (its wrappings cascade); how many went. */
  delete(kind: string, resourceId: string): Promise<number>;
  /** Every wrapping of these keys, by key id, holder kind, then holder. */
  wrappings(keyIds: string[]): Promise<ResourceKeyWrappingRecord[]>;
  /** Whether `holder` holds a wrapping of the key of one of these kinds. */
  holdsWrapping(keyId: string, holder: string, holderKinds: string[]): Promise<boolean>;
  /** Insert a wrapping, or replace its wrapped key, version and granter in place. */
  upsertWrapping(wrapping: ResourceKeyWrappingInput): Promise<void>;
  /** Insert a wrapping unless the (key, kind, holder) one exists; true when written. */
  insertWrappingIfAbsent(wrapping: ResourceKeyWrappingInput): Promise<boolean>;
  /** Delete `holder`'s wrappings of the key of these kinds; how many went. */
  deleteWrappings(keyId: string, holder: string, holderKinds: string[]): Promise<number>;
  /** Who holds a wrapping of the key, oldest first (ties by holder kind, then holder). */
  holders(keyId: string): Promise<ResourceKeyHolderRecord[]>;
  /**
   * The resource's key id with one holder's wrapping of one kind beside it
   * (null when they hold none); null when the resource has no key.
   */
  findWithWrapping(
    kind: string,
    resourceId: string,
    holderKind: string,
    holder: string
  ): Promise<{ id: string; wrappedKey: string | null } | null>;
  /**
   * Delete the keys whose resource (chat, chat project, prompt library,
   * artifact) no longer exists; how many went. Keys of other kinds stay.
   */
  pruneOrphans(): Promise<number>;
}
