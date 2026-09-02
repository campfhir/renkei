/**
 * Reaching a person over Outlook and WebEx from the interactive worker,
 * using their OWN grants — the shared arm behind every owner alert this
 * worker sends (an agent run failing, a batch job starting or finishing).
 *
 * The posture is agent-run-failed.ts's, now in one place: each channel is
 * independently wanted (the caller has already consulted Preferences), a
 * channel the person never connected is skipped silently, and NOTHING here
 * throws — a notification retrying through the queue would re-mail the
 * owner every backoff, and the page the alert points at shows the same
 * news regardless. Notification is reach, never the record.
 *
 * Email goes from the owner's Outlook to the owner's recorded address (the
 * identities row); WebEx is a note-to-self, since WebEx cannot deliver a
 * 1:1 message to your own address — see WebexClient.sendNoteToSelf.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { graphRequest } from '@renkei/connector-microsoft';
import { WebexClient } from '@renkei/connector-webex';
import { resolveMicrosoftAccess } from './microsoft-access';
import { resolveWebexUserAccessBySubject } from './webex-linked-user';
import { logger } from '../logger';

export interface OwnerChannelMessage {
  tenantId: string;
  ownerSubject: string;
  /** Which channels the owner asked for — already resolved against Preferences. */
  email: boolean;
  webex: boolean;
  /** The email subject, and the WebEx note's bold first line. */
  heading: string;
  /** Plain text; the WebEx note gets it verbatim under the heading. */
  body: string;
  /** Logging context — the component and whatever names the thing announced. */
  log: { component: string } & Record<string, unknown>;
}

export async function deliverToOwnerChannels(
  db: Kysely<DB>,
  message: OwnerChannelMessage
): Promise<void> {
  if (!message.email && !message.webex) return;
  const { tenantId, ownerSubject } = message;

  // Channel 1: email from the owner's own Outlook grant, to themselves.
  if (message.email) {
    try {
      const identity = await db
        .selectFrom('identities')
        .select(['email'])
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', ownerSubject)
        .executeTakeFirst();
      if (identity?.email) {
        const grant = await db
          .selectFrom('provider_grants')
          .select('provider_account_id')
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', 'microsoft')
          .where('subject', '=', ownerSubject)
          .executeTakeFirst();
        if (grant) {
          const access = await resolveMicrosoftAccess(tenantId, grant.provider_account_id);
          const sent = await graphRequest(access.accessToken, '/me/sendMail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: {
                subject: message.heading,
                body: { contentType: 'Text', content: message.body },
                toRecipients: [{ emailAddress: { address: identity.email } }],
              },
              saveToSentItems: false,
            }),
          });
          if (!sent.ok) logger.warn('owner email not sent', message.log);
        }
      }
      // No recorded email = nowhere to deliver; the page still shows it.
    } catch (error) {
      logger.warn('owner email errored: {error}', {
        ...message.log,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Channel 2: a WebEx note-to-self from the owner's own WebEx grant.
  if (message.webex) {
    try {
      const access = await resolveWebexUserAccessBySubject(tenantId, ownerSubject);
      if (access) {
        const client = new WebexClient(access.accessToken);
        const sent = await client.sendNoteToSelf(`**${message.heading}**\n\n${message.body}`);
        if (!sent.ok) logger.warn('owner WebEx note not sent', message.log);
      }
    } catch (error) {
      logger.warn('owner WebEx note errored: {error}', {
        ...message.log,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
