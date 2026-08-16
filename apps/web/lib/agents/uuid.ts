/**
 * A uuid that works in both runtimes the builder's modules load in —
 * `node:crypto` would break the client bundle, and the bare Web Crypto
 * call reads as a mistake at call sites without this name.
 */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
