/**
 * The delegate client (docs/delegate-key-design.md): what the web app and
 * the workers call instead of @renkei/user-keys. Same verbs, same error
 * words, one difference — no key is derived in the calling process. A
 * resource op answers the resource's data key, which is what the caller's
 * request is about to read anyway; a person-only value is opened and
 * sealed by the delegate itself.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  KekError,
  KekMode,
  OpenKeyError,
  ResourceKey,
  ResourceKeyKind,
  ResourceRef,
  PassphraseError,
  UnlockError,
} from '@renkei/user-keys';
import {
  DelegateTransport,
  delegateConfigFromEnv,
  isRecord,
  type DelegateCallError,
  type DelegateTransportError,
  type FetchLike,
} from './transport';

export {
  DelegateTransport,
  delegateConfigFromEnv,
  type DelegateCallError,
  type DelegateConfig,
  type DelegateTransportError,
  type FetchLike,
} from './transport';

/** The status the preferences page shows; dates as ISO strings over the wire. */
export interface DelegateKeyStatus {
  mode: KekMode;
  version: number;
  locked: boolean;
  unlockedUntil: Date | null;
  createdAt: Date | null;
  rotatedAt: Date | null;
}

/** Every verdict a key op can come back with, the delegate's transport ones included. */
export type KeyOpError = OpenKeyError | 'NO_USER_KEY' | DelegateTransportError | 'DELEGATE_ERROR';
export type OwnKeyError =
  | KekError
  | PassphraseError
  | UnlockError
  | 'NOT_MANAGED'
  | 'DECRYPTION_ERROR'
  | DelegateTransportError
  | 'DELEGATE_ERROR';

const KEY_OP_ERRORS: readonly KeyOpError[] = [
  'DELEGATE_UNCONFIGURED',
  'DELEGATE_UNREACHABLE',
  'MISSING_USER_KEY_MASTER',
  'INVALID_ENCRYPTION_KEY',
  'KEY_LOCKED',
  'NO_KEY',
  'NO_ACCESS',
  'DECRYPTION_ERROR',
  'NO_USER_KEY',
];
const OWN_KEY_ERRORS: readonly OwnKeyError[] = [
  'DELEGATE_UNCONFIGURED',
  'DELEGATE_UNREACHABLE',
  'MISSING_USER_KEY_MASTER',
  'INVALID_ENCRYPTION_KEY',
  'NO_USER_KEY',
  'KEY_LOCKED',
  'PASSPHRASE_TOO_SHORT',
  'PASSPHRASE_TOO_LONG',
  'NOT_OWN_KEY',
  'NOT_MANAGED',
  'WRONG_PASSPHRASE',
  'DECRYPTION_ERROR',
];

function keyOpError(error: DelegateCallError): KeyOpError {
  return KEY_OP_ERRORS.find((known) => known === error.type) ?? 'DELEGATE_ERROR';
}

function ownKeyError(error: DelegateCallError): OwnKeyError {
  return OWN_KEY_ERRORS.find((known) => known === error.type) ?? 'DELEGATE_ERROR';
}

function keyOf(json: Record<string, unknown>): ResourceKey | null {
  if (typeof json.id !== 'string' || typeof json.key !== 'string') return null;
  const key = Buffer.from(json.key, 'base64');
  if (key.byteLength !== 32) return null;
  return { id: json.id, key };
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function statusOf(json: Record<string, unknown>): DelegateKeyStatus {
  return {
    mode: json.mode === 'own' ? 'own' : 'managed',
    version: typeof json.version === 'number' ? json.version : 0,
    locked: json.locked === true,
    unlockedUntil: dateOf(json.unlockedUntil),
    createdAt: dateOf(json.createdAt),
    rotatedAt: dateOf(json.rotatedAt),
  };
}

function refBody(ref: ResourceRef): Record<string, unknown> {
  return { tenantId: ref.tenantId, kind: ref.kind, resourceId: ref.resourceId };
}

export class DelegateClient {
  constructor(private readonly transport: DelegateTransport) {}

  /** From DELEGATE_WORKER_URL / DELEGATE_WORKER_API_KEY; unconfigured still constructs, and every op says so. */
  static fromEnv(fetchImpl?: FetchLike): DelegateClient {
    return new DelegateClient(new DelegateTransport(delegateConfigFromEnv(), fetchImpl));
  }

  get configured(): boolean {
    return this.transport.configured;
  }

  private async key(
    op: string,
    body: Record<string, unknown>
  ): Promise<Result<ResourceKey, KeyOpError>> {
    const answer = await this.transport.call(op, body);
    if (!answer.ok) return err(keyOpError(answer.err));
    const key = keyOf(answer.val);
    return key ? ok(key) : err('DELEGATE_ERROR' as const);
  }

  // ── resource keys ────────────────────────────────────────────────────────

  /** The resource's key, minted and wrapped for its owner if it has none yet. */
  ensureResourceKey(
    ref: ResourceRef,
    ownerSubject: string
  ): Promise<Result<ResourceKey, KeyOpError>> {
    return this.key('resource-key/ensure', { ...refBody(ref), ownerSubject });
  }

  createResourceKey(
    ref: ResourceRef,
    ownerSubject: string
  ): Promise<Result<ResourceKey, KeyOpError>> {
    return this.key('resource-key/create', { ...refBody(ref), ownerSubject });
  }

  /** The resource's key as this person holds it. */
  openResourceKey(ref: ResourceRef, subject: string): Promise<Result<ResourceKey, KeyOpError>> {
    return this.key('resource-key/open', { ...refBody(ref), subject });
  }

  /** Many at once (the sidebar's search): a resource missing from the map could not be opened. */
  async openResourceKeys(
    tenantId: string,
    kind: ResourceKeyKind,
    entries: { resourceId: string; subject: string }[]
  ): Promise<Result<Map<string, ResourceKey>, KeyOpError>> {
    if (entries.length === 0) return ok(new Map());
    const answer = await this.transport.call('resource-key/open-many', { tenantId, kind, entries });
    if (!answer.ok) return err(keyOpError(answer.err));
    const out = new Map<string, ResourceKey>();
    if (isRecord(answer.val.keys)) {
      for (const [resourceId, value] of Object.entries(answer.val.keys)) {
        const key = isRecord(value) ? keyOf(value) : null;
        if (key) out.set(resourceId, key);
      }
    }
    return ok(out);
  }

  async shareResourceKey(
    ref: ResourceRef,
    fromSubject: string,
    toSubject: string
  ): Promise<Result<void, KeyOpError>> {
    const answer = await this.transport.call('resource-key/share', {
      ...refBody(ref),
      fromSubject,
      toSubject,
    });
    return answer.ok ? ok(undefined) : err(keyOpError(answer.err));
  }

  async revokeResourceKey(ref: ResourceRef, subject: string): Promise<Result<boolean, KeyOpError>> {
    const answer = await this.transport.call('resource-key/revoke', { ...refBody(ref), subject });
    return answer.ok ? ok(answer.val.revoked === true) : err(keyOpError(answer.err));
  }

  async deleteResourceKey(ref: ResourceRef): Promise<Result<void, KeyOpError>> {
    const answer = await this.transport.call('resource-key/delete', refBody(ref));
    return answer.ok ? ok(undefined) : err(keyOpError(answer.err));
  }

  async hasResourceKey(ref: ResourceRef): Promise<Result<boolean, KeyOpError>> {
    const answer = await this.transport.call('resource-key/has', refBody(ref));
    return answer.ok ? ok(answer.val.exists === true) : err(keyOpError(answer.err));
  }

  async listResourceKeyHolders(
    ref: ResourceRef
  ): Promise<
    Result<{ subject: string; grantedBy: string | null; kekVersion: number }[], KeyOpError>
  > {
    const answer = await this.transport.call('resource-key/holders', refBody(ref));
    if (!answer.ok) return err(keyOpError(answer.err));
    const holders: { subject: string; grantedBy: string | null; kekVersion: number }[] = [];
    if (Array.isArray(answer.val.holders)) {
      for (const item of answer.val.holders) {
        if (!isRecord(item) || typeof item.subject !== 'string') continue;
        holders.push({
          subject: item.subject,
          grantedBy: typeof item.grantedBy === 'string' ? item.grantedBy : null,
          kekVersion: typeof item.kekVersion === 'number' ? item.kekVersion : 0,
        });
      }
    }
    return ok(holders);
  }

  // ── person-only values ───────────────────────────────────────────────────

  /** `uenc1:` envelopes under this person's key, one per value, in order. */
  async sealForSubject(
    tenantId: string,
    subject: string,
    values: string[]
  ): Promise<Result<string[], KeyOpError>> {
    if (values.length === 0) return ok([]);
    const answer = await this.transport.call('user-sealed/seal', { tenantId, subject, values });
    if (!answer.ok) return err(keyOpError(answer.err));
    const sealed = Array.isArray(answer.val.sealed) ? answer.val.sealed : [];
    const out: string[] = [];
    for (const item of sealed) {
      if (typeof item !== 'string') return err('DELEGATE_ERROR' as const);
      out.push(item);
    }
    if (out.length !== values.length) return err('DELEGATE_ERROR' as const);
    return ok(out);
  }

  /** The values opened, in order; null where one would not open. A missing or locked key fails the batch. */
  async openForSubject(
    tenantId: string,
    subject: string,
    stored: string[]
  ): Promise<Result<(string | null)[], KeyOpError>> {
    if (stored.length === 0) return ok([]);
    const answer = await this.transport.call('user-sealed/open', { tenantId, subject, stored });
    if (!answer.ok) return err(keyOpError(answer.err));
    const opened = Array.isArray(answer.val.opened) ? answer.val.opened : [];
    const out: (string | null)[] = [];
    for (const item of opened) {
      if (item !== null && typeof item !== 'string') return err('DELEGATE_ERROR' as const);
      out.push(item);
    }
    if (out.length !== stored.length) return err('DELEGATE_ERROR' as const);
    return ok(out);
  }

  // ── a person's own key ───────────────────────────────────────────────────

  private async ownKey(
    op: string,
    body: Record<string, unknown>
  ): Promise<Result<DelegateKeyStatus, OwnKeyError>> {
    const answer = await this.transport.call(op, body);
    return answer.ok ? ok(statusOf(answer.val)) : err(ownKeyError(answer.err));
  }

  getUserKeyStatus(
    tenantId: string,
    subject: string
  ): Promise<Result<DelegateKeyStatus, OwnKeyError>> {
    return this.ownKey('own-key/status', { tenantId, subject });
  }

  adoptOwnKey(
    tenantId: string,
    subject: string,
    passphrase: string,
    options: { unlockMs?: number } = {}
  ): Promise<Result<DelegateKeyStatus, OwnKeyError>> {
    return this.ownKey('own-key/adopt', {
      tenantId,
      subject,
      passphrase,
      unlockMs: options.unlockMs,
    });
  }

  unlockOwnKey(
    tenantId: string,
    subject: string,
    passphrase: string,
    options: { unlockMs?: number } = {}
  ): Promise<Result<DelegateKeyStatus, OwnKeyError>> {
    return this.ownKey('own-key/unlock', {
      tenantId,
      subject,
      passphrase,
      unlockMs: options.unlockMs,
    });
  }

  lockOwnKey(tenantId: string, subject: string): Promise<Result<DelegateKeyStatus, OwnKeyError>> {
    return this.ownKey('own-key/lock', { tenantId, subject });
  }

  revertToManagedKey(
    tenantId: string,
    subject: string,
    passphrase: string
  ): Promise<Result<DelegateKeyStatus, OwnKeyError>> {
    return this.ownKey('own-key/revert', { tenantId, subject, passphrase });
  }

  // ── the managed key itself, and maintenance ──────────────────────────────

  async rotateUserKek(
    tenantId: string,
    subject: string
  ): Promise<Result<{ version: number; rewrapped: number }, OwnKeyError>> {
    const answer = await this.transport.call('user-key/rotate', { tenantId, subject });
    if (!answer.ok) return err(ownKeyError(answer.err));
    return ok({
      version: typeof answer.val.version === 'number' ? answer.val.version : 0,
      rewrapped: typeof answer.val.rewrapped === 'number' ? answer.val.rewrapped : 0,
    });
  }

  async shredUserKek(tenantId: string, subject: string): Promise<Result<boolean, OwnKeyError>> {
    const answer = await this.transport.call('user-key/shred', { tenantId, subject });
    return answer.ok ? ok(answer.val.shredded === true) : err(ownKeyError(answer.err));
  }

  async pruneOrphanResourceKeys(): Promise<Result<number, KeyOpError>> {
    const answer = await this.transport.call('maintenance/prune-orphan-keys', {});
    if (!answer.ok) return err(keyOpError(answer.err));
    return ok(typeof answer.val.pruned === 'number' ? answer.val.pruned : 0);
  }
}

let shared: DelegateClient | null = null;

/** The process-wide client, built once from the environment. */
export function delegateClient(): DelegateClient {
  shared ??= DelegateClient.fromEnv();
  return shared;
}

/** Tests: replace the process-wide client (null restores the env-built one). */
export function setDelegateClient(client: DelegateClient | null): void {
  shared = client;
}

export {
  DelegateGrants,
  delegateGrants,
  delegateRefusal,
  grantFetch,
  setDelegateGrants,
  type AuthedFetch,
  type DelegateFetchOptions,
  type ExchangeOutcome,
  type GrantDescription,
  type GrantOpError,
  type GrantRef,
} from './api';
