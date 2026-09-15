/**
 * The vault: where a browser secret's passphrase-derived key is held
 * between an unlock and its expiry. With a key store (secret-key-store.ts,
 * the shared data disk, sealed under the deployment's key narrowed to the
 * owner and secret) the held key is written there and read back on every
 * use, so any sandbox replica can type the secret and a lock on any
 * replica locks all. Without one, it is this process's memory and nothing
 * more — a restart locks every secret. Either way the UI reads "locked"
 * from here rather than from a column that could disagree.
 *
 * `unlock` proves the passphrase by opening the sealed blob (AES-GCM's
 * tag fails on the wrong key), so a wrong passphrase is refused rather
 * than held. Keys lapse by their window on every read and in a periodic
 * sweep, go on `lock`, and — in memory — wholesale on `close`.
 */

import { deriveSecretKey, openSecretFieldsWithKey, sealedSalt } from '@renkei/connector-sandbox';
import type { HeldKey, SecretKeyStore, SecretOwner } from './secret-key-store';

export interface SecretVaultDeps {
  now?: () => number;
  sweepIntervalMs?: number;
  /** Where held keys live between calls when this deployment shares them across replicas. */
  store?: SecretKeyStore | null;
}

export class SecretVault {
  private readonly keys = new Map<string, HeldKey>();
  private readonly now: () => number;
  private readonly store: SecretKeyStore | null;
  private readonly sweep: NodeJS.Timeout;

  constructor(deps: SecretVaultDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.store = deps.store ?? null;
    this.sweep = setInterval(() => void this.sweepExpired(), deps.sweepIntervalMs ?? 60_000);
    this.sweep.unref();
  }

  /**
   * Derive the key from the passphrase, verify it opens the blob, and hold
   * it until `untilMs`. False when the passphrase (or the blob) is wrong.
   */
  async unlock(
    owner: SecretOwner,
    secretId: string,
    sealed: string,
    passphrase: string,
    untilMs: number
  ): Promise<boolean> {
    const salt = sealedSalt(sealed);
    if (!salt) return false;
    const key = deriveSecretKey(passphrase, salt);
    if (!openSecretFieldsWithKey(sealed, key)) {
      key.fill(0);
      return false;
    }
    await this.lock(secretId);
    if (this.store) {
      await this.store.save(owner, secretId, { key, until: untilMs });
      key.fill(0);
    } else {
      this.keys.set(secretId, { key, until: untilMs });
    }
    return true;
  }

  /** The held key, or null once it has lapsed (in which case it is dropped now). */
  private async keyFor(owner: SecretOwner, secretId: string): Promise<HeldKey | null> {
    if (this.store) return this.store.load(owner, secretId, this.now());
    const held = this.keys.get(secretId);
    if (!held) return null;
    if (held.until <= this.now()) {
      await this.lock(secretId);
      return null;
    }
    return held;
  }

  /** Open a secret's fields with its held key; null when locked or when the blob no longer opens. */
  async open(
    owner: SecretOwner,
    secretId: string,
    sealed: string
  ): Promise<Record<string, string> | null> {
    const held = await this.keyFor(owner, secretId);
    if (!held) return null;
    return openSecretFieldsWithKey(sealed, held.key);
  }

  async unlockedUntil(owner: SecretOwner, secretId: string): Promise<Date | null> {
    const held = await this.keyFor(owner, secretId);
    return held ? new Date(held.until) : null;
  }

  /** Forget a key — here and on the shared disk; true when one was held. */
  async lock(secretId: string): Promise<boolean> {
    const held = this.keys.get(secretId);
    if (held) {
      held.key.fill(0);
      this.keys.delete(secretId);
    }
    const onDisk = this.store ? await this.store.remove(secretId) : false;
    return held !== undefined || onDisk;
  }

  /** Keys held in this process's memory (none, with a store). */
  size(): number {
    const now = this.now();
    for (const [id, held] of Array.from(this.keys.entries())) {
      if (held.until <= now) {
        held.key.fill(0);
        this.keys.delete(id);
      }
    }
    return this.keys.size;
  }

  /** Drop what has lapsed, in memory and on disk. */
  async sweepExpired(): Promise<void> {
    this.size();
    await this.store?.sweep(this.now()).catch(() => 0);
  }

  /** Forget every key this process holds; keys on the shared disk stay for the other replicas. */
  close(): void {
    clearInterval(this.sweep);
    for (const [id, held] of Array.from(this.keys.entries())) {
      held.key.fill(0);
      this.keys.delete(id);
    }
  }
}
