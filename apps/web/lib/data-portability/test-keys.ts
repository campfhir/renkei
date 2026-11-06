/**
 * Keys for the data-portability route tests, on the memory store: a real
 * resource cipher per chat or project (one random key each, so a chat's
 * rows really are sealed and opened), and the delegate's person-only
 * sealing as a reversible stand-in. The tests' jest.mock factories call
 * these; nothing in the app imports this file.
 */

import { randomBytes } from 'node:crypto';
import { resourceCipher, unavailableCipher, type ContentCipher } from '@/lib/chat/content-crypto';

const keys = new Map<string, Buffer>();
let blocked = false;

/** From now on, a chat's key cannot be opened (an undelegated session). */
export function blockChatKeys(value: boolean): void {
  blocked = value;
}

/** The resource's key, minted on first use; what createKey hands back. */
export async function testCreateKey(
  kind: string,
  resource: { id: string }
): Promise<{ id: string; key: Buffer }> {
  const id = `${kind}-${resource.id}`;
  const key = keys.get(id) ?? randomBytes(32);
  keys.set(id, key);
  return { id, key };
}

export async function testCipherFor(
  kind: string,
  resource: { id: string }
): Promise<ContentCipher> {
  if (blocked && kind === 'chat') return unavailableCipher('delegation');
  return resourceCipher(await testCreateKey(kind, resource));
}

export const testPersonSealing = {
  async sealForSubject(subject: string, values: string[]) {
    return { ok: true as const, val: values.map((value) => `sealed:${subject}:${value}`) };
  },
  async openForSubject(subject: string, stored: string[]) {
    const prefix = `sealed:${subject}:`;
    return {
      ok: true as const,
      val: stored.map((value) => (value.startsWith(prefix) ? value.slice(prefix.length) : null)),
    };
  },
};
