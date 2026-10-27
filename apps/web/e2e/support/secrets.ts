/**
 * An org-wide secret sealed the way the admin forms seal it: `@renkei/crypto`'s
 * secretbox under the memory server's TOKEN_ENCRYPTION_KEY (fixed by
 * playwright.memory.config.ts). For the `encryptedSecrets` of a connector
 * config or a model a spec writes through the store.
 */

import { MEMORY_TOKEN_ENCRYPTION_KEY } from '../memory/constants';
import { secretbox } from './crypto';

export function sealOrgSecret(value: unknown): string {
  return secretbox(JSON.stringify(value), Buffer.from(MEMORY_TOKEN_ENCRYPTION_KEY, 'base64'));
}
