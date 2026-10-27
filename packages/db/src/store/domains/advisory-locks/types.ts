/**
 * Single-runner elections across worker processes: run `fn` only when no
 * other holder has the named lock, and skip otherwise. Postgres takes a
 * session-level advisory lock (`pg_try_advisory_lock(hashtext(namespace),
 * hashtext(name))`) and releases it on the same pinned connection; memory
 * keeps the held names in an in-process Set, which elects one runner per
 * process — the single-process equivalent.
 */
export interface AdvisoryLockStore {
  /**
   * Take the lock and run `fn`, releasing it afterwards even when `fn`
   * throws (the throw propagates). Resolves false, without calling `fn`,
   * when someone else holds it.
   */
  withTryLock(namespace: string, name: string, fn: () => Promise<void>): Promise<boolean>;
}
