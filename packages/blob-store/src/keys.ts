/**
 * Object keys are built from identifiers, never from anything a caller
 * typed: a filename belongs in the metadata row, not in the storage path.
 * The same rule the sandbox worker keeps for its disk layout.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The key domain (@renkei/settings getKeyDomain): a former organization id, or the fixed word. */
const DOMAIN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9-]{0,31})$/i;

/**
 * `chat/<domain>/<attachment id>`. The domain segment is where a deployment
 * that was once multi-tenant already keeps its files; a new one uses the
 * fixed word. Either way the path is built from identifiers alone.
 */
export function chatAttachmentKey(
  domain: string,
  attachmentId: string
): Result<string, 'INVALID_KEY_PART'> {
  if (!DOMAIN.test(domain) || !UUID.test(attachmentId)) {
    return err('INVALID_KEY_PART' as const, {
      message: 'Object keys are built from identifiers only.',
    });
  }
  return ok(`chat/${domain.toLowerCase()}/${attachmentId.toLowerCase()}`);
}
