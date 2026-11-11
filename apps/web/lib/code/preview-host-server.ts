/**
 * The server half of previews on a host of their own (preview-host.ts):
 * the organization's setting, the signing key, and who may see a member's
 * preview — the same reading access the app's own preview routes ask for
 * (route-access.ts), from a subject rather than a session.
 */

import type { NextRequest } from 'next/server';
import { loadKeyring } from '@renkei/crypto';
import { getOrgSettings } from '@renkei/settings';
import { getProjectRow } from '@/lib/chat/projects';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getChatRow } from '@/lib/chat/store';
import { isUuid } from '@/lib/uuid';
import { previewHostBase, previewSigningKey } from './preview-host';

/** The organization's preview host, or '' when previews are served on the app's own origin. */
export async function codePreviewHost(): Promise<string> {
  const settings = await getOrgSettings();
  return settings.ok ? settings.val.codePreviewHost : '';
}

/** The key the handoff is signed with; null when the deployment has no encryption key to derive it from. */
export function previewHostKey(): Buffer | null {
  const keyring = loadKeyring('TOKEN_ENCRYPTION_KEY');
  return keyring.ok ? previewSigningKey(keyring.val) : null;
}

/** Whether this person may look at a preview of the project (and, when named, of that chat's worktree). */
export async function mayViewPreview(
  subject: string,
  projectId: string,
  chatId: string | null
): Promise<boolean> {
  if (!isUuid(projectId) || (chatId !== null && !isUuid(chatId))) return false;
  const access = await resolveResourceAccess(subject, 'chat_project', projectId);
  if (!access) return false;
  const project = await getProjectRow(projectId);
  if (!project || project.kind !== 'code' || !project.repo) return false;
  if (chatId === null) return true;
  const chat = await getChatRow(chatId);
  return Boolean(chat && chat.projectId === project.id);
}

/**
 * For the app's own preview addresses once a preview host is set: they no
 * longer serve a preview (its HTML must not run on the app's origin). A
 * page load is sent on to the same preview on the preview host; anything
 * else is told there is nothing here. Null while no host is set, and the
 * route serves as before.
 */
export async function movedToPreviewHost(
  request: NextRequest,
  hostPath: string,
  rest: string[] | undefined
): Promise<Response | null> {
  const host = await codePreviewHost();
  if (!host) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json(
      { error: 'Previews are served on the preview host.', code: 'not-found' },
      { status: 404 }
    );
  }
  const tail = (rest ?? []).map((segment) => encodeURIComponent(segment)).join('/');
  const target = `${previewHostBase(host)}${hostPath}${tail}${request.nextUrl.search}`;
  return new Response(null, {
    status: 307,
    headers: { location: target, 'cache-control': 'no-store' },
  });
}
