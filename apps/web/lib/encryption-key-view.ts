/**
 * What the preferences page shows about a person's encryption key
 * (docs/user-encryption-keys-design.md, "Your own key"): the JSON shape of
 * the key status, shared by the route that serves it and the page that
 * renders it on first load. Dates travel as ISO strings so the same object
 * can be rendered on the server and refreshed from the route.
 */

import type { UserKeyStatus } from '@renkei/user-keys';

export interface EncryptionKeyView {
  mode: 'managed' | 'own';
  /** For `own`: whether the key is usable right now, and until when. */
  locked: boolean;
  unlockedUntil: string | null;
  version: number;
  rotatedAt: string | null;
}

export function toEncryptionKeyView(status: UserKeyStatus): EncryptionKeyView {
  return {
    mode: status.mode,
    locked: status.locked,
    unlockedUntil: status.unlockedUntil ? status.unlockedUntil.toISOString() : null,
    version: status.version,
    rotatedAt: status.rotatedAt ? status.rotatedAt.toISOString() : null,
  };
}
