/**
 * Whether Outlook/WebEx are even worth offering as delivery channels on the
 * preferences page — read-only and best-effort, since this only gates a
 * checkbox's disabled state, never the send itself.
 *
 * The send itself is re-checked independently, at the moment it happens: an
 * agent run only has `outlook_send_mail` / `webex_note_to_self` in its own
 * tool set when the owner's grant carries the scope that tool needs
 * (capability-registry filters registration by granted scope), so a stale
 * "yes" here just means the checkbox looked enabled and the send quietly
 * no-ops — never a send with no authorization behind it.
 *
 * Deliberately shallow: `granted_scopes` is a plaintext column, so this is
 * one query and no token decryption, unlike resolving actual Graph/WebEx
 * access (@/lib/mcp-tools/graph/client.ts, @/lib/webex-user-access.ts).
 */

import { getDatabase } from '@renkei/db';
import { MICROSOFT, WEBEX_USER } from '@renkei/provider-grants';
import { outlookScopeFor } from '@/lib/mcp-tools/outlook';
import { webexScopeFor } from '@/lib/mcp-tools/webex';

export interface ChannelAvailability {
  outlook: boolean;
  webex: boolean;
}

const OUTLOOK_REQUIRED = outlookScopeFor('outlook_send_mail');
const WEBEX_REQUIRED = webexScopeFor('webex_note_to_self');

export async function getChannelAvailability(
  tenantId: string,
  subject: string
): Promise<ChannelAvailability> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { outlook: false, webex: false };

  const rows = await dbResult.val
    .selectFrom('provider_grants')
    .select(['provider', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('provider', 'in', [MICROSOFT, WEBEX_USER])
    .execute()
    .catch(() => []);

  const hasScopes = (provider: string, required: string[]) => {
    const row = rows.find((r) => r.provider === provider);
    const granted = new Set(row?.granted_scopes ?? []);
    return required.length > 0 && required.every((scope) => granted.has(scope));
  };

  return {
    outlook: hasScopes(MICROSOFT, OUTLOOK_REQUIRED),
    webex: hasScopes(WEBEX_USER, WEBEX_REQUIRED),
  };
}
