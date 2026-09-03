/**
 * The in-memory vault: the ONLY place a browser secret's key exists in
 * plaintext, and only between an unlock and its expiry. Nothing here is
 * ever written anywhere — a worker restart locks every secret, which is
 * the intended failure mode, and the UI reads "locked" from this process
 * rather than from a column that could disagree with it.
 *
 * `unlock` proves the passphrase by opening the sealed blob (AES-GCM's
 * tag fails on the wrong key), so a wrong passphrase is refused rather
 * than stored. Keys are dropped by expiry on every read and by a periodic
 * sweep, by `lock`, and wholesale by `close`.
 */

import { deriveSecretKey, openSecretFieldsWithKey, sealedSalt } from '@renkei/connector-sandbox';

interface Unlocked {
  key: Buffer;
  until: number;
}

export interface SecretVaultDeps {
  now?: () => number;
  sweepIntervalMs?: number;
}

export class SecretVault {
  private readonly keys = new Map<string, Unlocked>();
  private readonly now: () => number;
  private readonly sweep: NodeJS.Timeout;

  constructor(deps: SecretVaultDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.sweep = setInterval(() => this.dropExpired(), deps.sweepIntervalMs ?? 60_000);
    this.sweep.unref();
  }

  /**
   * Derive the key from the passphrase, verify it opens the blob, and hold
   * it until `untilMs`. False when the passphrase (or the blob) is wrong.
   */
  unlock(secretId: string, sealed: string, passphrase: string, untilMs: number): boolean {
    const salt = sealedSalt(sealed);
    if (!salt) return false;
    const key = deriveSecretKey(passphrase, salt);
    if (!openSecretFieldsWithKey(sealed, key)) {
      key.fill(0);
      return false;
    }
    this.lock(secretId);
    this.keys.set(secretId, { key, until: untilMs });
    return true;
  }

  /** The held key, or null once it has lapsed (in which case it is dropped now). */
  keyFor(secretId: string): Buffer | null {
    const held = this.keys.get(secretId);
    if (!held) return null;
    if (held.until <= this.now()) {
      this.lock(secretId);
      return null;
    }
    return held.key;
  }

  /** Open a secret's fields with its held key; null when locked or when the blob no longer opens. */
  open(secretId: string, sealed: string): Record<string, string> | null {
    const key = this.keyFor(secretId);
    if (!key) return null;
    return openSecretFieldsWithKey(sealed, key);
  }

  unlockedUntil(secretId: string): Date | null {
    return this.keyFor(secretId) ? new Date(this.keys.get(secretId)!.until) : null;
  }

  /** Forget a key; true when one was held. */
  lock(secretId: string): boolean {
    const held = this.keys.get(secretId);
    if (!held) return false;
    held.key.fill(0);
    this.keys.delete(secretId);
    return true;
  }

  size(): number {
    this.dropExpired();
    return this.keys.size;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, held] of Array.from(this.keys.entries())) {
      if (held.until <= now) this.lock(id);
    }
  }

  close(): void {
    clearInterval(this.sweep);
    for (const id of Array.from(this.keys.keys())) this.lock(id);
  }
}
