/**
 * Per-person settings: one JSON value per (subject, key). The value comes
 * back as it was stored (an object stays an object), and its shape is the
 * caller's to check — @renkei/user-prefs parses every read.
 */
export interface UserPreferenceStore {
  /** Undefined when the person has never saved this key. */
  get(subject: string, key: string): Promise<unknown>;
  set(subject: string, key: string, value: unknown): Promise<void>;
  /** Forget a saved key, so it reads as never set; a key never saved is left alone. */
  delete(subject: string, key: string): Promise<void>;
  /** Everyone's saved value of one key, by subject. */
  listByKey(key: string): Promise<{ subject: string; value: unknown }[]>;
}
