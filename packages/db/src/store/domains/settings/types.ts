/** Org-wide settings: one JSON value per key (@renkei/settings parses them). */
export interface SettingsStore {
  /** Every stored key and its value. */
  all(): Promise<Map<string, unknown>>;
  /** Undefined when the key has never been set. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
