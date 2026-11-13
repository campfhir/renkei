/**
 * What a sandbox's worker is started with, sealed under the sandbox's own
 * key (docs/sandbox-orchestrator-design.md).
 *
 * A sandbox's secrets — its key for the delegate, the key its workspace
 * secrets are sealed with — are not put in its environment, where the
 * platform's own tooling, a process listing or a data-loss scanner on the
 * way would read them in the clear. The one thing a sandbox is created
 * with is its own bearer key. Its worker asks the orchestrator for the
 * rest at boot, and the orchestrator answers it SEALED: AES-256-GCM under
 * a key derived from that sandbox's key, bound to the sandbox's id. So
 * what crosses the network, and what any inspector between the two sees,
 * is ciphertext only the sandbox it was made for can open — and the
 * answer for one sandbox is noise to every other.
 *
 * Shared by the orchestrator (which seals) and the sandbox worker (which
 * opens); node:crypto only.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const INFO = 'renkei-sandbox-sealed-env-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The sealing key of one sandbox, from its bearer key. */
function sealingKey(sandboxKey: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(sandboxKey, 'utf8'), Buffer.alloc(0), INFO, 32)
  );
}

/** Seal an environment for the sandbox that holds `sandboxKey`. */
export function sealSandboxEnv(
  sandboxKey: string,
  sandboxId: string,
  env: Record<string, string>
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(sandboxKey), iv);
  cipher.setAAD(Buffer.from(sandboxId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(env), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/**
 * Open what `sealSandboxEnv` made for this sandbox. Null when it was not
 * sealed for this key and id, was changed on the way, or is not an
 * environment — never a partial answer.
 */
export function openSandboxEnv(
  sandboxKey: string,
  sandboxId: string,
  sealed: string
): Record<string, string> | null {
  try {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sealingKey(sandboxKey),
      raw.subarray(0, IV_BYTES)
    );
    decipher.setAAD(Buffer.from(sandboxId, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(plain);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') return null;
      env[name] = value;
    }
    return env;
  } catch {
    return null;
  }
}
