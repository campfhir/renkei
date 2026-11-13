/**
 * The bearer key one sandbox's worker takes. Derived, not stored: an HMAC
 * of the sandbox's id under the deployment's master key
 * (SANDBOX_WORKER_API_KEY), so the orchestrator can hand a caller the key
 * of any sandbox without a table of them, and what one sandbox holds in
 * its environment opens no other sandbox.
 */

import { createHmac } from 'node:crypto';

export function sandboxApiKey(masterKey: string, sandboxId: string): string {
  return createHmac('sha256', masterKey).update(`renkei-sandbox:${sandboxId}`).digest('base64url');
}
