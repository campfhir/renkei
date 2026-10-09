/**
 * The delegate client (docs/delegate-key-design.md): what the web app and
 * the workers call instead of @renkei/user-keys. Same verbs, same error
 * words, one difference — no key exists in the calling process. A
 * resource op answers the resource's data key, which is what the caller's
 * request is about to read anyway; a person-only value is opened and
 * sealed by the delegate itself; enrollment and delegations carry only
 * what the browser sealed.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  CreateKeyOptions,
  DelegateError,
  DelegationInput,
  DelegationStatus,
  EnrollError,
  EnrollInput,
  KeyError,
  LiveInstance,
  OpenKeyError,
  ResourceKey,
  ResourceKeyHolder,
  ResourceKeyKind,
  ResourceRef,
  RotateError,
  RotateInput,
  SealScope,
  ShareKeyError,
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
  delegateApiKeyFromEnv,
  delegateConfigFromEnv,
  developmentDelegateKeyRefusal,
  DEVELOPMENT_DELEGATE_KEY,
  type DelegateCallError,
  type DelegateConfig,
  type DelegateTransportError,
  type FetchLike,
} from './transport';

/** Every verdict a key op can come back with, the delegate's transport ones included. */
export type KeyOpError =
  OpenKeyError | ShareKeyError | 'NO_USER_KEY' | DelegateTransportError | 'DELEGATE_ERROR';

/** The enrollment, delegation and rotation verdicts. */
export type KeysOpError =
  KeyError | EnrollError | DelegateError | RotateError | DelegateTransportError | 'DELEGATE_ERROR';

const KEY_OP_ERRORS: readonly KeyOpError[] = [
  'DELEGATE_UNCONFIGURED',
  'DELEGATE_UNREACHABLE',
  'NO_USER_KEY',
  'NOT_ENROLLED',
  'NEEDS_DELEGATION',
  'NEEDS_SESSION',
  'NO_VAULT',
  'NO_KEY',
  'NO_ACCESS',
  'GRANTEE_NOT_ENROLLED',
  'DECRYPTION_ERROR',
];
const KEYS_OP_ERRORS: readonly KeysOpError[] = [
  'DELEGATE_UNCONFIGURED',
  'DELEGATE_UNREACHABLE',
  'NO_USER_KEY',
  'NOT_ENROLLED',
  'NEEDS_DELEGATION',
  'NEEDS_SESSION',
  'NO_VAULT',
  'BAD_DELEGATION',
  'KEY_MISMATCH',
  'ALREADY_ENROLLED',
  'MIGRATION_UNAVAILABLE',
  'KEY_LOCKED',
  'WRONG_PASSPHRASE',
  'DECRYPTION_ERROR',
  'SESSION_MISMATCH',
];

function keyOpError(error: DelegateCallError): KeyOpError {
  return KEY_OP_ERRORS.find((known) => known === error.type) ?? 'DELEGATE_ERROR';
}

function keysOpError(error: DelegateCallError): KeysOpError {
  return KEYS_OP_ERRORS.find((known) => known === error.type) ?? 'DELEGATE_ERROR';
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

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function refBody(ref: ResourceRef): Record<string, unknown> {
  return { tenantId: ref.tenantId, kind: ref.kind, resourceId: ref.resourceId };
}

/** A person's enrollment and delegations as the delegate reports them; dates parsed. */
export interface KeyStatus extends Omit<DelegationStatus, 'enrolledAt' | 'automationUntil'> {
  enrolledAt: Date | null;
  automationUntil: Date | null;
}

function statusOf(json: Record<string, unknown>): KeyStatus {
  return {
    enrolled: json.enrolled === true,
    legacy: json.legacy === true,
    legacyNeedsPassphrase: json.legacyNeedsPassphrase === true,
    publicKey: typeof json.publicKey === 'string' ? json.publicKey : null,
    wrappedPrivateKey: typeof json.wrappedPrivateKey === 'string' ? json.wrappedPrivateKey : null,
    wrappedAutomationKey:
      typeof json.wrappedAutomationKey === 'string' ? json.wrappedAutomationKey : null,
    version: typeof json.version === 'number' ? json.version : 0,
    enrolledAt: dateOf(json.enrolledAt),
    sessionInstances: stringsOf(json.sessionInstances),
    thisSessionInstances: stringsOf(json.thisSessionInstances),
    automationInstances: stringsOf(json.automationInstances),
    automationUntil: dateOf(json.automationUntil),
  };
}

/** The delegation half of an enroll, delegate or rotate request, as the wire carries it. */
function delegationBody(input: DelegationInput): Record<string, unknown> {
  return {
    tenantId: input.tenantId,
    subject: input.subject,
    sessionId: input.sessionId,
    session: input.session,
    automation: input.automation,
    automationUntil: input.automationUntil ? input.automationUntil.toISOString() : null,
    revokeSession: input.revokeSession === true,
  };
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

  /**
   * This client's ops bound to a browser session: the delegate checks the
   * session is the subject's and live, and opens that session's delegation
   * alone (docs/delegate-key-design.md, "Callers").
   */
  forSession(sessionId: string): DelegateClient {
    return new DelegateClient(this.transport.withBound({ sessionId }));
  }

  /** The agents worker's ops bound to the run they serve: the delegate checks the run is the subject's. */
  forRun(runId: string): DelegateClient {
    return new DelegateClient(this.transport.withBound({ runId }));
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

  private async keys(
    op: string,
    body: Record<string, unknown>
  ): Promise<Result<Record<string, unknown>, KeysOpError>> {
    const answer = await this.transport.call(op, body);
    return answer.ok ? ok(answer.val) : err(keysOpError(answer.err));
  }

  // ── the person's keys ────────────────────────────────────────────────────

  /** The live delegate instances: what a browser seals a person's key to. */
  async keyInstances(): Promise<Result<LiveInstance[], KeysOpError>> {
    const answer = await this.keys('keys/instances', {});
    if (!answer.ok) return answer;
    const instances: LiveInstance[] = [];
    if (Array.isArray(answer.val.instances)) {
      for (const item of answer.val.instances) {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.publicKey !== 'string')
          continue;
        instances.push({ id: item.id, publicKey: item.publicKey });
      }
    }
    return ok(instances);
  }

  /** A person's enrollment and what is delegated for them, as of this session when given. */
  async keyStatus(
    tenantId: string,
    subject: string,
    sessionId?: string
  ): Promise<Result<KeyStatus, KeysOpError>> {
    const answer = await this.keys('keys/status', { tenantId, subject, sessionId });
    return answer.ok ? ok(statusOf(answer.val)) : answer;
  }

  async enroll(
    input: EnrollInput
  ): Promise<
    Result<{ version: number; migrated: { grants: number; values: number } }, KeysOpError>
  > {
    const answer = await this.keys('keys/enroll', {
      ...delegationBody(input),
      publicKey: input.publicKey,
      wrappedPrivateKey: input.wrappedPrivateKey,
      wrappedAutomationKey: input.wrappedAutomationKey,
      passphrase: input.passphrase,
    });
    if (!answer.ok) return answer;
    const migrated = isRecord(answer.val.migrated) ? answer.val.migrated : {};
    return ok({
      version: typeof answer.val.version === 'number' ? answer.val.version : 0,
      migrated: {
        grants: typeof migrated.grants === 'number' ? migrated.grants : 0,
        values: typeof migrated.values === 'number' ? migrated.values : 0,
      },
    });
  }

  async delegate(input: DelegationInput): Promise<Result<void, KeysOpError>> {
    const answer = await this.keys('keys/delegate', delegationBody(input));
    return answer.ok ? ok(undefined) : answer;
  }

  async revokeAutomation(tenantId: string, subject: string): Promise<Result<number, KeysOpError>> {
    const answer = await this.keys('keys/revoke-automation', { tenantId, subject });
    if (!answer.ok) return answer;
    return ok(typeof answer.val.revoked === 'number' ? answer.val.revoked : 0);
  }

  async rotateUserKey(
    input: RotateInput
  ): Promise<Result<{ version: number; moved: number }, KeysOpError>> {
    const answer = await this.keys('keys/rotate', {
      ...delegationBody(input),
      wrappedPrivateKey: input.wrappedPrivateKey,
      wrappedAutomationKey: input.wrappedAutomationKey,
    });
    if (!answer.ok) return answer;
    return ok({
      version: typeof answer.val.version === 'number' ? answer.val.version : 0,
      moved: typeof answer.val.moved === 'number' ? answer.val.moved : 0,
    });
  }

  async shredUserKey(tenantId: string, subject: string): Promise<Result<boolean, KeysOpError>> {
    const answer = await this.keys('keys/shred', { tenantId, subject });
    return answer.ok ? ok(answer.val.shredded === true) : answer;
  }

  async enrollmentCensus(
    tenantId?: string
  ): Promise<Result<{ held: number; managed: number; own: number }, KeysOpError>> {
    const answer = await this.keys('keys/census', { tenantId });
    if (!answer.ok) return answer;
    const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
    return ok({
      held: count(answer.val.held),
      managed: count(answer.val.managed),
      own: count(answer.val.own),
    });
  }

  // ── resource keys ────────────────────────────────────────────────────────

  /** The resource's key, minted and wrapped for its owner if it has none yet. */
  ensureResourceKey(
    ref: ResourceRef,
    ownerSubject: string,
    options: CreateKeyOptions = {}
  ): Promise<Result<ResourceKey, KeyOpError>> {
    return this.key('resource-key/ensure', {
      ...refBody(ref),
      ownerSubject,
      automation: options.automation === true,
    });
  }

  createResourceKey(
    ref: ResourceRef,
    ownerSubject: string,
    options: CreateKeyOptions = {}
  ): Promise<Result<ResourceKey, KeyOpError>> {
    return this.key('resource-key/create', {
      ...refBody(ref),
      ownerSubject,
      automation: options.automation === true,
    });
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

  /** A chat's key under its project's: whoever opens the project opens the chat. */
  async wrapResourceKeyUnder(
    ref: ResourceRef,
    bySubject: string,
    parent: ResourceRef
  ): Promise<Result<void, KeyOpError>> {
    const answer = await this.transport.call('resource-key/wrap-under', {
      ...refBody(ref),
      bySubject,
      parentKind: parent.kind,
      parentResourceId: parent.resourceId,
    });
    return answer.ok ? ok(undefined) : err(keyOpError(answer.err));
  }

  /** Let the person's agents at the resource while they are away. */
  async grantAutomationAccess(
    ref: ResourceRef,
    subject: string
  ): Promise<Result<void, KeyOpError>> {
    const answer = await this.transport.call('resource-key/grant-automation', {
      ...refBody(ref),
      subject,
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

  async listResourceKeyHolders(ref: ResourceRef): Promise<Result<ResourceKeyHolder[], KeyOpError>> {
    const answer = await this.transport.call('resource-key/holders', refBody(ref));
    if (!answer.ok) return err(keyOpError(answer.err));
    const holders: ResourceKeyHolder[] = [];
    if (Array.isArray(answer.val.holders)) {
      for (const item of answer.val.holders) {
        if (!isRecord(item) || typeof item.holder !== 'string') continue;
        const kind = item.holderKind;
        holders.push({
          holderKind:
            kind === 'automation' || kind === 'public' || kind === 'resource' ? kind : 'user',
          holder: item.holder,
          grantedBy: typeof item.grantedBy === 'string' ? item.grantedBy : null,
          kekVersion: typeof item.kekVersion === 'number' ? item.kekVersion : 0,
        });
      }
    }
    return ok(holders);
  }

  // ── person-only values ───────────────────────────────────────────────────

  /** Envelopes under this person's key for the scope, one per value, in order. */
  async sealForSubject(
    tenantId: string,
    subject: string,
    values: string[],
    scope: SealScope = 'automation'
  ): Promise<Result<string[], KeyOpError>> {
    if (values.length === 0) return ok([]);
    const answer = await this.transport.call('user-sealed/seal', {
      tenantId,
      subject,
      values,
      scope,
    });
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

  /** The values opened, in order; null where one would not open. A key that is missing or not delegated fails the batch. */
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

  // ── maintenance ──────────────────────────────────────────────────────────

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
  authedFetch,
  delegateGrants,
  delegateRefusal,
  grantFetch,
  grantKeyOf,
  setDelegateGrants,
  type AuthedFetch,
  type DelegateFetchOptions,
  type ExchangeOutcome,
  type GitProxy,
  type GrantDescription,
  type GrantOpError,
  type GrantRef,
} from './api';
