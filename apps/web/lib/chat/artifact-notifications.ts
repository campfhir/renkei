/**
 * The notices an artifact's owner and the people around it get: a share
 * ("X shared a file with you"), a copy ("X made a copy of your file"),
 * a hand-over ("X handed a file over to you"). In-app row plus push,
 * gated by the person's chat-shared preference — the same door as a
 * shared chat, since it is the same kind of news — and fire-and-forget,
 * the way share-notification.ts does it.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export type ArtifactNotificationKind =
  'artifact_shared' | 'artifact_copied' | 'artifact_transferred';

export function artifactHeadline(
  kind: ArtifactNotificationKind,
  actorName: string,
  filename: string
): string {
  switch (kind) {
    case 'artifact_shared':
      return `${actorName} shared "${filename}" with you`;
    case 'artifact_copied':
      return `${actorName} made a copy of "${filename}"`;
    case 'artifact_transferred':
      return `${actorName} handed "${filename}" over to you`;
  }
}

export function notifyArtifactEvent(input: {
  kind: ArtifactNotificationKind;
  recipientSubject: string;
  actorSubject: string;
  artifactId: string;
  filename: string;
}): void {
  if (input.recipientSubject === input.actorSubject) return;
  // The person who acted as {actor}, the one being told as {recipient}.
  const about = async () => {
    const recipient = await whoIs(input.recipientSubject);
    return {
      component: 'chat/artifact-notifications',
      ...(await whoIs(input.actorSubject)),
      recipient: recipient.actor,
      recipientSubject: recipient.subject,
      recipientEmail: recipient.email,
      artifactId: input.artifactId,
      filename: input.filename,
      did:
        input.kind === 'artifact_shared'
          ? 'shared'
          : input.kind === 'artifact_copied'
            ? 'made a copy of'
            : 'handed over',
    };
  };
  void (async () => {
    const prefs = await getNotificationPrefs(input.recipientSubject, { fresh: true });
    if (!prefs.chatShared.app) return;
    const fields = await about();
    const who = await getIdentityDisplay(input.actorSubject);
    const actorName = who?.displayName || who?.email || 'Someone';
    const headline = artifactHeadline(input.kind, actorName, input.filename);
    const refUrl = `/chat/artifacts?artifact=${input.artifactId}`;
    const id = randomUUID();
    await getDataStore().notifications.insert({
      id,
      subject: input.recipientSubject,
      kind: input.kind,
      category: null,
      connector: null,
      tool: null,
      entity: null,
      headline,
      refUrl,
      agentId: null,
      agentName: null,
      runId: null,
      meta: null,
    });
    const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
    if (keyResult.ok) {
      void sendPush(
        input.recipientSubject,
        keyResult.val,
        {
          title: headline,
          body:
            input.kind === 'artifact_copied'
              ? 'Their copy is theirs; your file and your shares are unchanged.'
              : input.filename,
          tag: id,
          refUrl,
          notificationId: id,
          appPath: refUrl,
        },
        { log: (message, meta) => logger.warn(message, { ...fields, ...meta }) }
      );
    }
  })().catch(async (error: unknown) => {
    logger.warn('{actor} {did} "{filename}", but {recipient} was not notified of it: {error}', {
      ...(await about()),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
