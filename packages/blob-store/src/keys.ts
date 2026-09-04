/**
 * Object keys are built from identifiers, never from anything a caller
 * typed: a filename belongs in the metadata row, not in the storage path.
 * The same rule the sandbox worker keeps for its disk layout.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function chatAttachmentKey(
  tenantId: string,
  attachmentId: string
): Result<string, 'INVALID_KEY_PART'> {
  if (!UUID.test(tenantId) || !UUID.test(attachmentId)) {
    return err('INVALID_KEY_PART' as const, { message: 'Object keys are built from UUIDs only.' });
  }
  return ok(`chat/${tenantId.toLowerCase()}/${attachmentId.toLowerCase()}`);
}
