/**
 * SSH host-key pinning for SFTP shares — the piece ssh2 leaves to the
 * caller. Without a `hostVerifier`, ssh2 accepts whatever key a server
 * presents, so a DNS or route hijack between the worker and the file
 * server would hand the person's password (or let a private key sign for)
 * an impostor. Here a share carries the server's key as an OpenSSH-style
 * fingerprint (`SHA256:<base64>`, what `ssh-keygen -lf` prints) — pinned
 * by an admin, or recorded on the first successful connection for the
 * admin to confirm — and every later connection is refused when the key
 * does not match. Pure: the socket work is sftp.ts's.
 */

import { createHash } from 'node:crypto';

/** The canonical form a stored fingerprint takes. */
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** OpenSSH's fingerprint of a raw public-key blob: `SHA256:` plus unpadded base64. */
export function hostKeyFingerprint(key: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Normalize what an admin pastes — `SHA256:...` as ssh-keygen prints it,
 * with or without the prefix, with or without base64 padding — to the
 * canonical form; null for an empty value, undefined for one that is not
 * a SHA-256 fingerprint at all.
 */
export function normalizeHostKeyFingerprint(raw: string): string | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  let body = text.replace(/^sha256:/i, '');
  while (body.endsWith('=')) body = body.slice(0, -1);
  const candidate = `SHA256:${body}`;
  return FINGERPRINT_PATTERN.test(candidate) ? candidate : undefined;
}

export interface HostKeyVerdict {
  /** What the server presented. */
  seen: string;
  /** What the share has pinned, or null when this connection is the first. */
  pinned: string | null;
  accepted: boolean;
}

/**
 * ssh2's synchronous `hostVerifier` contract — `(key: Buffer) => boolean` —
 * for one connection: accept the pinned key and nothing else, or, with
 * none pinned, accept and report what was seen so the caller can record
 * it. `onVerdict` always learns the outcome, so a refusal can name both
 * fingerprints in the error a person reads.
 */
export function makeHostVerifier(
  pinned: string | null,
  onVerdict: (verdict: HostKeyVerdict) => void
): (key: Buffer) => boolean {
  return (key) => {
    const seen = hostKeyFingerprint(key);
    const accepted = pinned === null || pinned === seen;
    onVerdict({ seen, pinned, accepted });
    return accepted;
  };
}

/** The message a refused connection carries — names both keys so the admin can tell a rotation from an impostor. */
export function hostKeyMismatchMessage(host: string, verdict: HostKeyVerdict): string {
  return (
    `SSH host key mismatch for ${host}: the server presented ${verdict.seen}, but this share pins ${verdict.pinned ?? '(none)'}. ` +
    "Refusing to connect. If the server's key was legitimately rotated, an admin can update the fingerprint on the share's page; otherwise the connection may be intercepted."
  );
}
