/**
 * Deployment-wide values (platform_settings) that belong to no person and
 * no organization setting — the VAPID key pair that signs every push, say.
 * Values are stored JSON; whatever is sealed in them stays sealed here.
 */
export interface PlatformSettingStore {
  /** The stored value, or null when the key has none. */
  get(key: string): Promise<{ value: unknown } | null>;
  /**
   * Store `value` under `key` unless one is already there (two processes
   * racing to mint the same value keep whichever landed first). True when
   * this call wrote it.
   */
  insertIfAbsent(key: string, value: unknown): Promise<boolean>;
}
