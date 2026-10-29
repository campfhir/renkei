import type {
  DecryptFn,
  EncryptFn,
  LogAdapter,
  LogQueryOptions,
  LogRow,
} from '@campfhir/bored-logs';
import type { E2ERegistrationStore } from '@campfhir/bored-logs/server';

/** encrypt/decrypt for secure()-stored attributes; both or neither, as the adapter wants them. */
export interface LogCipher {
  encrypt: EncryptFn;
  decrypt: DecryptFn;
}

/**
 * The activity log. The rows (`logs`, `log_attr`, …) are written
 * by the logging adapter (@campfhir/bored-logs), never by the app; this is
 * exactly what the activity page and the log search route read back —
 * and what the retention sweep purges.
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
  /**
   * A logging adapter that writes records into the log tables — what the
   * log-shipping ingest route hands its sink. Records below `level`
   * (default 'info') are dropped; with a cipher, secure() values are stored
   * encrypted. Postgres is bored-logs' own PostgresAdapter (batched; call
   * `flush` to write now, `close` to stop its timers). Memory writes each
   * record as it arrives and agrees with the adapter on null, string,
   * number, boolean, Date and JSON attributes and the shipper's
   * application/version; it does not truncate long keys or move oversized
   * values to the blob table.
   */
  writer(options?: { level?: string; cipher?: LogCipher }): LogAdapter;
  /**
   * Where log shippers' E2E registrations live. Postgres is bored-logs'
   * PsqlE2ERegistrationStore (log_e2e_clients); memory keeps them in this
   * store instance, gone with the process — as bored-logs' own default
   * store does.
   */
  shippingRegistrations(): E2ERegistrationStore;
  /**
   * Retention: delete up to `limit` log records logged at or before
   * `until`, with their attributes and blobs, in one atomic step; returns
   * how many records went. Which records a partial batch takes is
   * Postgres's choice (no ORDER BY, so the purge stays an index walk);
   * memory takes the lowest log ids. Callers loop until a batch comes back
   * short.
   */
  purgeBefore(until: Date, limit: number): Promise<number>;
}
