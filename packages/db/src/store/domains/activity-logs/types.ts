import type { DecryptFn, EncryptFn, LogQueryOptions, LogRow } from '@campfhir/bored-logs';

/** encrypt/decrypt for secure()-stored attributes; both or neither, as the adapter wants them. */
export interface LogCipher {
  encrypt: EncryptFn;
  decrypt: DecryptFn;
}

/**
 * The activity log, read-only. The rows (`logs`, `log_attr`, …) are written
 * by the logging adapter (@campfhir/bored-logs), never by the app; this is
 * exactly what the activity page and the log search route read back.
 */
export interface ActivityLogStore {
  /**
   * The adapter's `query()` over the log tables: the time window (start
   * inclusive, end exclusive; the adapter's defaults are the last 24 hours
   * and now), the levels, `message`, and the `attributeFilter` tree, sorted
   * by timestamp, `limit` capped at 1000. With a cipher, secure() values
   * come back decrypted. Rejects with the adapter's message when it refuses
   * the query (an unknown level).
   *
   * Postgres runs the adapter itself. Memory evaluates the same tree in
   * JavaScript and agrees with it for: `$message`, `$level` and `$timestamp`
   * leaves; flat attribute leaves with `=`, `contains`, null, and ordered
   * comparisons against numbers, ISO dates and strings; JSON-path leaves
   * without a `[*]` wildcard on plain values. A wildcard path never matches
   * in memory, and a JSON value is matched by its JSON text; ties on the
   * timestamp come back by log id in memory and in no defined order in
   * Postgres, so the differential scenarios keep timestamps distinct.
   */
  search(options: LogQueryOptions, cipher?: LogCipher): Promise<LogRow[]>;
  /** Display names of the grants with these provider account ids (for the User column). */
  grantNamesByAccountIds(
    accountIds: string[]
  ): Promise<{ providerAccountId: string; displayName: string }[]>;
}
