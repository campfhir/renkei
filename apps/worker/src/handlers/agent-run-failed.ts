/**
 * The agents/run.failed handler — telling the owner their agent broke,
 * over whichever of Outlook/WebEx their own Preferences say they want AND
 * have connected. Each channel is independently gated: `runFailed.email`
 * for the Outlook mail, `runFailed.webex` for the WebEx note-to-self, and a
 * channel that isn't connected is skipped silently either way — the run
 * page shows the failure regardless, so notification is reach, never the
 * record.
 *
 * Deliberately never throws on delivery: a notification retrying through
 * the queue would re-mail the owner every backoff. Only missing
 * prerequisites (db down) throw for redelivery.
 */

import { getDatabase } from '@renkei/db';
import { graphRequest } from '@renkei/connector-microsoft';
import { WebexClient } from '@renkei/connector-webex';
import { getNotificationPrefs } from '@renkei/user-prefs';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveMicrosoftAccess } from './microsoft-access';
import { resolveWebexUserAccessBySubject } from './webex-linked-user';
import { registrationUrl } from './feed-url';
import { logger } from '../logger';

interface FailedPayload {
  runId: string;
  agentId: string;
  ownerSubject: string;
  errorKind: string | null;
}

function parsePayload(event: ClaimedEvent): FailedPayload | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: {
    runId?: unknown;
    agentId?: unknown;
    ownerSubject?: unknown;
    errorKind?: unknown;
  } = payload;
  if (typeof record.runId !== 'string' || typeof record.agentId !== 'string') return null;
  if (typeof record.ownerSubject !== 'string') return null;
  return {
    runId: record.runId,
    agentId: record.agentId,
    ownerSubject: record.ownerSubject,
    errorKind: typeof record.errorKind === 'string' ? record.errorKind : null,
  };
}

/**
 * Human wording for a raw error_kind — the fallback when the run row has no
 * error sentence. Local copy: the worker cannot import apps/web's
 * run-labels, and six literals beat a shared package.
 */
function friendlyErrorKind(errorKind: string): string {
  switch (errorKind) {
    case 'step_failed':
      return 'a step failed';
    case 'config':
      return 'a setup problem';
    case 'timeout':
      return 'it ran out of time';
    case 'llm_auth':
      return 'an AI model sign-in problem';
    case 'llm_error':
      return 'an AI model error';
    case 'llm_rate_limit':
      return 'the AI model was busy';
    case 'guard':
      return 'a safety guard stopped it';
    default:
      return errorKind;
  }
}

export function createAgentRunFailedHandler(): EventHandler {
  return async (event) => {
    const payload = parsePayload(event);
    if (!payload) {
      logger.warn('run.failed event with malformed payload; dropping', {
        component: 'worker/agent-notify',
      });
      return;
    }
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;

    // Cheapest check first: nothing on either channel means no grant
    // lookups, no Graph/WebEx calls — just done.
    const prefs = await getNotificationPrefs(tenantId, payload.ownerSubject);
    if (!prefs.runFailed.email && !prefs.runFailed.webex) return;

    const [agent, run, identity, base] = await Promise.all([
      db.selectFrom('agents').select('name').where('id', '=', payload.agentId).executeTakeFirst(),
      db
        .selectFrom('agent_runs')
        .select(['error'])
        .where('id', '=', payload.runId)
        .executeTakeFirst(),
      db
        .selectFrom('identities')
        .select(['email'])
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', payload.ownerSubject)
        .executeTakeFirst(),
      registrationUrl(tenantId),
    ]);

    const agentName = agent?.name ?? 'Your agent';
    const reason =
      run?.error ??
      (payload.errorKind ? friendlyErrorKind(payload.errorKind) : 'an unknown problem');
    const link = base ? `${base}/agents/${payload.agentId}/runs/${payload.runId}` : null;
    const bodyText = `Your agent “${agentName}” stopped on a failure: ${reason}${link ? `\n\nSee the run: ${link}` : ''}`;

    // Channel 1: email from the owner's own Outlook grant, to themselves.
    if (prefs.runFailed.email) {
      if (!identity?.email) {
        // No recorded email = nowhere to deliver; the run page still shows it.
      } else {
        try {
          const grant = await db
            .selectFrom('provider_grants')
            .select('provider_account_id')
            .where('tenant_id', '=', tenantId)
            .where('provider', '=', 'microsoft')
            .where('subject', '=', payload.ownerSubject)
            .executeTakeFirst();
          if (grant) {
            const access = await resolveMicrosoftAccess(tenantId, grant.provider_account_id);
            const sent = await graphRequest(access.accessToken, '/me/sendMail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: {
                  subject: `Agent “${agentName}” failed`,
                  body: { contentType: 'Text', content: bodyText },
                  toRecipients: [{ emailAddress: { address: identity.email } }],
                },
                saveToSentItems: false,
              }),
            });
            if (!sent.ok) {
              logger.warn('failure mail not sent for run {runId}', {
                component: 'worker/agent-notify',
                runId: payload.runId,
              });
            }
          }
        } catch (error) {
          logger.warn('failure mail errored for run {runId}: {error}', {
            component: 'worker/agent-notify',
            runId: payload.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Channel 2: a WebEx note-to-self from the owner's own WebEx grant.
    // WebEx cannot deliver a 1:1 message to your own address — see
    // WebexClient.sendNoteToSelf for the find-or-create room dance that
    // gets around it.
    if (prefs.runFailed.webex) {
      try {
        const access = await resolveWebexUserAccessBySubject(tenantId, payload.ownerSubject);
        if (access) {
          const client = new WebexClient(access.accessToken);
          const sent = await client.sendNoteToSelf(
            `**Agent “${agentName}” failed**\n\n${bodyText}`
          );
          if (!sent.ok) {
            logger.warn('failure WebEx note not sent for run {runId}', {
              component: 'worker/agent-notify',
              runId: payload.runId,
            });
          }
        }
      } catch (error) {
        logger.warn('failure WebEx note errored for run {runId}: {error}', {
          component: 'worker/agent-notify',
          runId: payload.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
