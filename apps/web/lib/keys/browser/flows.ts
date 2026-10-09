/**
 * The browser's side of the key design (docs/delegate-key-design.md), as
 * the flows a page runs:
 *
 *   enroll     — generate the user key, the keypair and the automation
 *                key; wrap the latter two under the user key; seal the
 *                user key (session) and the automation key (automation) to
 *                every live delegate instance; post it all; keep the user
 *                key on this device. The key is returned once for showing.
 *   delegate   — with the user key on this device: open the automation key
 *                from its wrapping, seal both to the live instances, post.
 *   rotate     — a new user key: re-wrap the private and automation keys
 *                under it, seal it, post; keep the new key on this device.
 *   adopt      — a key typed in, or received from another device: check it
 *                opens the wrappings, keep it on this device, delegate.
 *   devices    — ask another device for the key, or answer an ask.
 *
 * Every secret here lives in this tab's memory for the length of a call
 * and on this device under the device key; what goes over the wire is
 * wrappings and sealed boxes.
 */

import {
  base64ToBytes,
  bytesToBase64,
  DEVICE_CODE_CHARS,
  deviceCodeOf,
  formatUserKey,
  generateKeyPair,
  instanceListMessage,
  normalizeDeviceCode,
  openSealedBox,
  parseUserKey,
  randomBytes,
  sealToPublicKey,
  unwrapBytes,
  utf8ToBytes,
  verifyEd25519,
  wrapBytes,
} from '@renkei/crypto/browser';
import type { KeyStatusView } from '../shared';
import { loadInstanceTrust, loadUserKey, saveUserKey, trustInstances } from './device-store';

export interface SealedDelegation {
  instanceId: string;
  sealedKey: string;
}

/** A delegate instance this browser has not sealed to before, as the person is shown it. */
export interface UnknownInstance {
  id: string;
  publicKey: string;
  /** The key's fingerprint: ten base32 characters of its SHA-256, as the delegate logs it at boot. */
  fingerprint: string;
}

export interface FlowFailure {
  code: string;
  error: string;
  /** For `untrusted_instances`: what the person is asked to confirm. */
  unknown?: UnknownInstance[];
}

/**
 * Which delegate am I sealing to? (docs/delegate-key-design.md.) The web app
 * hands this browser a list of instance public keys, and a compromised web
 * app would hand it one of its own. So the browser remembers the instance
 * keys it has sealed to (trust on first use) and takes a NEW key without
 * asking only when the list is signed by a deployment signing key it already
 * trusts. Anything else is handed back as `untrusted_instances` with the
 * fingerprints, and the page asks the person before a single byte is sealed.
 */
export async function checkInstanceTrust(
  tenantId: string,
  status: KeyStatusView
): Promise<{ ok: true } | { ok: false; failure: FlowFailure }> {
  const trust = await loadInstanceTrust(tenantId);
  const keys = status.instances.map((instance) => instance.publicKey);
  if (!trust) {
    // First use on this browser: whatever is here is what it will hold to.
    await trustInstances(tenantId, keys, status.instanceSigningKey);
    return { ok: true };
  }
  const unknown = status.instances.filter(
    (instance) => !trust.instanceKeys.includes(instance.publicKey)
  );
  if (unknown.length === 0) return { ok: true };
  if (
    status.instanceSigningKey &&
    status.instancesSignature &&
    trust.signingKeys.includes(status.instanceSigningKey)
  ) {
    const signingKey = base64ToBytes(status.instanceSigningKey);
    const signature = base64ToBytes(status.instancesSignature);
    if (
      signingKey &&
      signature &&
      (await verifyEd25519(
        signingKey,
        utf8ToBytes(instanceListMessage(status.instances)),
        signature
      ))
    ) {
      await trustInstances(tenantId, keys, status.instanceSigningKey);
      return { ok: true };
    }
  }
  const named: UnknownInstance[] = [];
  for (const instance of unknown) {
    const publicKey = base64ToBytes(instance.publicKey);
    named.push({
      id: instance.id,
      publicKey: instance.publicKey,
      fingerprint: publicKey && publicKey.length === 32 ? await deviceCodeOf(publicKey) : '?',
    });
  }
  return {
    ok: false,
    failure: {
      code: 'untrusted_instances',
      error: 'This browser has not sealed your key to this key service before; confirm it first.',
      unknown: named,
    },
  };
}

/** The person confirmed the unknown instances: remember them (and the signing key that came with them). */
export async function confirmInstanceTrust(
  tenantId: string,
  status: KeyStatusView,
  unknown: UnknownInstance[]
): Promise<void> {
  await trustInstances(
    tenantId,
    unknown.map((instance) => instance.publicKey),
    status.instanceSigningKey
  );
}

async function post(
  url: string,
  body: Record<string, unknown>,
  method = 'POST'
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; failure: FlowFailure }> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => ({}));
    const record: Record<string, unknown> =
      typeof json === 'object' && json !== null ? Object.fromEntries(Object.entries(json)) : {};
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          code: typeof record.code === 'string' ? record.code : `http_${response.status}`,
          error: typeof record.error === 'string' ? record.error : 'The request failed.',
        },
      };
    }
    return { ok: true, json: record };
  } catch {
    return { ok: false, failure: { code: 'network', error: 'Could not reach the server.' } };
  }
}

async function sealToInstances(
  instances: { id: string; publicKey: string }[],
  key: Uint8Array
): Promise<SealedDelegation[]> {
  const out: SealedDelegation[] = [];
  for (const instance of instances) {
    const publicKey = base64ToBytes(instance.publicKey);
    if (!publicKey || publicKey.length !== 32) continue;
    out.push({ instanceId: instance.id, sealedKey: await sealToPublicKey(publicKey, key) });
  }
  return out;
}

/** The automation key, from its wrapping under the user key; null when the key is not theirs. */
export async function automationKeyOf(
  status: KeyStatusView,
  userKey: Uint8Array
): Promise<Uint8Array | null> {
  if (!status.wrappedAutomationKey) return null;
  const opened = await unwrapBytes(status.wrappedAutomationKey, userKey);
  return opened && opened.length === 32 ? opened : null;
}

export interface EnrollOutcome {
  /** The key as the person writes it down. */
  shown: string;
  userKey: Uint8Array;
}

/** First sign-in: see the module comment. */
export async function enrollInBrowser(
  tenantId: string,
  status: KeyStatusView,
  options: { passphrase?: string; automationDays?: number } = {}
): Promise<{ ok: true; outcome: EnrollOutcome } | { ok: false; failure: FlowFailure }> {
  const trusted = await checkInstanceTrust(tenantId, status);
  if (!trusted.ok) return trusted;
  const userKey = randomBytes(32);
  const automationKey = randomBytes(32);
  const pair = await generateKeyPair();
  const body = {
    publicKey: bytesToBase64(pair.publicKey),
    wrappedPrivateKey: await wrapBytes(pair.privateKey, userKey),
    wrappedAutomationKey: await wrapBytes(automationKey, userKey),
    session: await sealToInstances(status.instances, userKey),
    automation: await sealToInstances(status.instances, automationKey),
    automationDays: options.automationDays,
    passphrase: options.passphrase,
  };
  if (body.session.length === 0) {
    return {
      ok: false,
      failure: { code: 'no_instances', error: 'No key service is running to hold your key.' },
    };
  }
  const answer = await post(`/api/tenant/${tenantId}/keys/enroll`, body);
  if (!answer.ok) return answer;
  await saveUserKey(tenantId, userKey);
  return { ok: true, outcome: { shown: formatUserKey(userKey), userKey } };
}

/** A later sign-in or a re-seal: fresh delegations from the key this device holds. */
export async function delegateInBrowser(
  tenantId: string,
  status: KeyStatusView,
  userKey: Uint8Array,
  options: { automation?: boolean; automationDays?: number } = {}
): Promise<{ ok: true } | { ok: false; failure: FlowFailure }> {
  const trusted = await checkInstanceTrust(tenantId, status);
  if (!trusted.ok) return trusted;
  const automationKey =
    options.automation === false ? null : await automationKeyOf(status, userKey);
  if (options.automation !== false && !automationKey) {
    return {
      ok: false,
      failure: { code: 'wrong_key', error: 'This key does not fit your account.' },
    };
  }
  const session = await sealToInstances(status.instances, userKey);
  if (session.length === 0) {
    // Nothing to seal to: the delegate refuses an empty list rather than
    // drop this session's rows, so say why here instead of asking.
    return {
      ok: false,
      failure: { code: 'no_instances', error: 'No key service is running to hold your key.' },
    };
  }
  const answer = await post(`/api/tenant/${tenantId}/keys/delegate`, {
    session,
    automation: automationKey ? await sealToInstances(status.instances, automationKey) : [],
    automationDays: options.automationDays,
  });
  return answer.ok ? { ok: true } : answer;
}

/** A new user key for this person; the old one is read from this device. */
export async function rotateInBrowser(
  tenantId: string,
  status: KeyStatusView,
  options: { automationDays?: number } = {}
): Promise<{ ok: true; outcome: EnrollOutcome } | { ok: false; failure: FlowFailure }> {
  const current = await loadUserKey(tenantId);
  if (!current) {
    return {
      ok: false,
      failure: { code: 'no_device_key', error: 'This device does not hold your key.' },
    };
  }
  const automationKey = await automationKeyOf(status, current);
  const privateKey = status.wrappedPrivateKey
    ? await unwrapBytes(status.wrappedPrivateKey, current)
    : null;
  if (!automationKey || !privateKey) {
    return {
      ok: false,
      failure: { code: 'wrong_key', error: 'The key on this device does not fit your account.' },
    };
  }
  const trusted = await checkInstanceTrust(tenantId, status);
  if (!trusted.ok) return trusted;
  const next = randomBytes(32);
  const answer = await post(`/api/tenant/${tenantId}/keys/rotate`, {
    wrappedPrivateKey: await wrapBytes(privateKey, next),
    wrappedAutomationKey: await wrapBytes(automationKey, next),
    session: await sealToInstances(status.instances, next),
    automation: await sealToInstances(status.instances, automationKey),
    automationDays: options.automationDays,
  });
  if (!answer.ok) return answer;
  await saveUserKey(tenantId, next);
  return { ok: true, outcome: { shown: formatUserKey(next), userKey: next } };
}

/** A key typed in (or received): it must open the account's wrappings before this device keeps it. */
export async function adoptKeyInBrowser(
  tenantId: string,
  status: KeyStatusView,
  candidate: Uint8Array
): Promise<{ ok: true } | { ok: false; failure: FlowFailure }> {
  if (!(await automationKeyOf(status, candidate))) {
    return {
      ok: false,
      failure: { code: 'wrong_key', error: 'That is not the key for this account.' },
    };
  }
  await saveUserKey(tenantId, candidate, { acknowledged: true });
  return delegateInBrowser(tenantId, status, candidate);
}

export function parseTypedKey(
  text: string
): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const parsed = parseUserKey(text);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    error:
      parsed.error === 'WRONG_LENGTH'
        ? 'A key is 14 groups of 4 characters.'
        : parsed.error === 'CHECKSUM'
          ? 'One of those characters is off; check the key against what you wrote down.'
          : 'A key uses only the letters a–z and the digits 2–7.',
  };
}

export interface DeviceAsk {
  id: string;
  code: string;
  /** This device's ephemeral private half, kept in memory until the answer arrives. */
  privateKey: Uint8Array<ArrayBuffer>;
  publicKey: Uint8Array<ArrayBuffer>;
}

/** This device asks the person's other devices for the key. */
export async function askOtherDevices(
  tenantId: string
): Promise<{ ok: true; ask: DeviceAsk } | { ok: false; failure: FlowFailure }> {
  const pair = await generateKeyPair();
  const answer = await post(`/api/tenant/${tenantId}/keys/devices`, {
    publicKey: bytesToBase64(pair.publicKey),
  });
  if (!answer.ok) return answer;
  const id = typeof answer.json.id === 'string' ? answer.json.id : '';
  const code = typeof answer.json.code === 'string' ? answer.json.code : '';
  if (!id || !code)
    return { ok: false, failure: { code: 'bad_answer', error: 'The request failed.' } };
  return { ok: true, ask: { id, code, privateKey: pair.privateKey, publicKey: pair.publicKey } };
}

/** Poll an ask: the key once another device sealed it to us, 'expired', or null while waiting. */
export async function pollDeviceAsk(
  tenantId: string,
  ask: DeviceAsk
): Promise<Uint8Array | 'expired' | 'gone' | null> {
  try {
    const response = await fetch(`/api/tenant/${tenantId}/keys/devices/${ask.id}`);
    if (response.status === 404) return 'gone';
    const json: unknown = await response.json().catch(() => ({}));
    const record: Record<string, unknown> =
      typeof json === 'object' && json !== null ? Object.fromEntries(Object.entries(json)) : {};
    if (typeof record.sealedKey === 'string') {
      const opened = await openSealedBox(
        { publicKey: ask.publicKey, privateKey: ask.privateKey },
        record.sealedKey
      );
      return opened && opened.length === 32 ? opened : 'gone';
    }
    return record.expired === true ? 'expired' : null;
  } catch {
    return null;
  }
}

/**
 * An enrolled device answers an ask: the person types the code the asking
 * device shows, this device reads the ask's public key against it and
 * posts the user key sealed to that public key, with the code again. A
 * wrong code is refused by the server, which counts it.
 */
export async function approveDeviceAsk(
  tenantId: string,
  requestId: string,
  typedCode: string,
  userKey: Uint8Array
): Promise<{ ok: true } | { ok: false; failure: FlowFailure }> {
  const code = normalizeDeviceCode(typedCode);
  if (!code) {
    return {
      ok: false,
      failure: {
        code: 'bad_code',
        error: `A code is ${DEVICE_CODE_CHARS} letters and digits, as the other device shows it.`,
      },
    };
  }
  const detail = await fetch(
    `/api/tenant/${tenantId}/keys/devices/${requestId}?code=${encodeURIComponent(code)}`
  ).catch(() => null);
  const json: unknown = detail ? await detail.json().catch(() => ({})) : {};
  const record: Record<string, unknown> =
    typeof json === 'object' && json !== null ? Object.fromEntries(Object.entries(json)) : {};
  if (!detail || !detail.ok) {
    return {
      ok: false,
      failure: {
        code: typeof record.code === 'string' ? record.code : 'gone',
        error: typeof record.error === 'string' ? record.error : 'That request is gone.',
      },
    };
  }
  const publicKey = typeof record.publicKey === 'string' ? base64ToBytes(record.publicKey) : null;
  if (!publicKey || publicKey.length !== 32) {
    return { ok: false, failure: { code: 'gone', error: 'That request is gone.' } };
  }
  const answer = await post(`/api/tenant/${tenantId}/keys/devices/${requestId}`, {
    code,
    sealedKey: await sealToPublicKey(publicKey, userKey),
  });
  return answer.ok ? { ok: true } : answer;
}

export async function denyDeviceAsk(tenantId: string, requestId: string): Promise<void> {
  await post(`/api/tenant/${tenantId}/keys/devices/${requestId}`, {}, 'DELETE');
}

export async function revokeAutomationInBrowser(
  tenantId: string
): Promise<{ ok: true } | { ok: false; failure: FlowFailure }> {
  const answer = await post(`/api/tenant/${tenantId}/keys/automation`, {}, 'DELETE');
  return answer.ok ? { ok: true } : answer;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The status route's JSON, read field by field. */
export function parseKeyStatus(json: unknown): KeyStatusView | null {
  if (typeof json !== 'object' || json === null) return null;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(json));
  if (typeof record.enrolled !== 'boolean') return null;
  const instances: { id: string; publicKey: string }[] = [];
  if (Array.isArray(record.instances)) {
    for (const item of record.instances) {
      if (typeof item !== 'object' || item === null) continue;
      const entry: Record<string, unknown> = Object.fromEntries(Object.entries(item));
      if (typeof entry.id === 'string' && typeof entry.publicKey === 'string') {
        instances.push({ id: entry.id, publicKey: entry.publicKey });
      }
    }
  }
  const pendingDevices: { id: string; createdAt: string; userAgent: string | null }[] = [];
  if (Array.isArray(record.pendingDevices)) {
    for (const item of record.pendingDevices) {
      if (typeof item !== 'object' || item === null) continue;
      const entry: Record<string, unknown> = Object.fromEntries(Object.entries(item));
      if (typeof entry.id === 'string') {
        pendingDevices.push({
          id: entry.id,
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
          userAgent: typeof entry.userAgent === 'string' ? entry.userAgent : null,
        });
      }
    }
  }
  return {
    enrolled: record.enrolled,
    legacy: record.legacy === true,
    legacyNeedsPassphrase: record.legacyNeedsPassphrase === true,
    publicKey: stringOrNull(record.publicKey),
    wrappedPrivateKey: stringOrNull(record.wrappedPrivateKey),
    wrappedAutomationKey: stringOrNull(record.wrappedAutomationKey),
    version: typeof record.version === 'number' ? record.version : 0,
    enrolledAt: stringOrNull(record.enrolledAt),
    instances,
    instanceSigningKey: stringOrNull(record.instanceSigningKey),
    instancesSignature: stringOrNull(record.instancesSignature),
    sessionDelegated: record.sessionDelegated === true,
    instancesMissingSession: strings(record.instancesMissingSession),
    automationInstances: strings(record.automationInstances),
    automationUntil: stringOrNull(record.automationUntil),
    automationDays: typeof record.automationDays === 'number' ? record.automationDays : 30,
    pendingDevices,
    unavailable: record.unavailable === true,
  };
}

export async function fetchKeyStatus(tenantId: string): Promise<KeyStatusView | null> {
  try {
    const response = await fetch(`/api/tenant/${tenantId}/keys`, { cache: 'no-store' });
    if (!response.ok) return null;
    return parseKeyStatus(await response.json());
  } catch {
    return null;
  }
}
