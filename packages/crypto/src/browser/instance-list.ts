/**
 * The delegate's signed instance list (docs/delegate-key-design.md, "Which
 * delegate am I sealing to?"): what the delegate signs and what a browser
 * verifies before it seals a person's key to an instance it has not seen.
 * One canonical string, built the same way on both sides — sorted, so the
 * order the rows came back in does not matter — under a version tag so a
 * later shape cannot be mistaken for this one.
 */

export const INSTANCE_LIST_TAG = 'renkei/delegate-instances/v1';

export interface SignedInstance {
  id: string;
  /** Raw X25519 public key, base64. */
  publicKey: string;
}

/** The bytes a signature covers: the tag, then `id:publicKey` per instance, sorted, newline-joined. */
export function instanceListMessage(instances: readonly SignedInstance[]): string {
  const lines = instances.map((instance) => `${instance.id}:${instance.publicKey}`).sort();
  return [INSTANCE_LIST_TAG, ...lines].join('\n');
}
