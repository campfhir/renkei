/**
 * The delegate instance's own keypair, as this package sees it: the one
 * thing that can open a delegation sealed to this instance
 * (docs/delegate-key-design.md, "The delegate"). Generated at boot, held
 * in memory, registered here by the delegate's entry point; the tests
 * register one of their own. Nothing in this package derives a key — it
 * opens what the browser sealed to this vault, or it has no key.
 */

import { openSealedBox, type X25519KeyPair } from '@renkei/crypto';

export interface KeyVault {
  /** `delegate_instances.id` — which delegations are this process's to open. */
  instanceId: string;
  publicKey: Buffer;
  /** The sealed key's bytes, or null when the box is not for this instance. */
  open(sealed: string): Buffer | null;
}

let current: KeyVault | null = null;

export function createKeyVault(instanceId: string, pair: X25519KeyPair): KeyVault {
  return {
    instanceId,
    publicKey: pair.publicKey,
    open: (sealed) => {
      const opened = openSealedBox(pair, sealed);
      return opened.ok ? opened.val : null;
    },
  };
}

/** Register the process's vault; null clears it (tests). */
export function setKeyVault(vault: KeyVault | null): void {
  current = vault;
}

export function keyVault(): KeyVault | null {
  return current;
}
