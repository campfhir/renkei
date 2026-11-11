/**
 * The "your model changed" note — written when an administrator removes a
 * model from the organization while it was a person's preferred chat model
 * or their projects, chats or agents were set to it. Each person it touched is told what was removed and what theirs run
 * on now: the replacement the administrator picked, or the organization's
 * default when none was.
 *
 * In the app (and by push, where a device is subscribed) for everyone it
 * touched: it reports a change someone else made to what they chose, so
 * no preference turns it off. A note that cannot be written never fails
 * the removal it describes.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type LlmModelUse } from '@renkei/db';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export const MODEL_REMOVED_KIND = 'model_removed';

/** What of one person's a removed model was set on. */
export interface ModelRemovedUse extends LlmModelUse {
  /** It was their preferred chat model. */
  preference: boolean;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "a", "a and b", "a, b and c". */
function listOf(parts: string[]): string {
  return parts.length <= 1
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** What one person reads: what went, what took its place, and for what of theirs. */
export function modelRemovedHeadline(input: {
  label: string;
  /** The model picked to take its place; null for the organization's default. */
  replacementLabel: string | null;
  preference: boolean;
  projects: number;
  chats: number;
  agents: number;
}): string {
  const touched = [
    input.preference ? 'your preferred chat model' : null,
    input.projects > 0 ? count(input.projects, 'project') : null,
    input.chats > 0 ? count(input.chats, 'chat') : null,
    input.agents > 0 ? count(input.agents, 'agent') : null,
  ].filter((part) => part !== null);
  const now = input.replacementLabel
    ? `"${input.replacementLabel}"`
    : "The organization's default model";
  return `An administrator removed the model "${input.label}". ${now} replaced it for ${listOf(touched)}.`;
}

/**
 * Everyone a model's removal touches, by subject: the owners of projects,
 * chats and agents set to it, and the people who prefer it for new chats.
 */
export function modelRemovedUses(
  uses: readonly LlmModelUse[],
  preferring: readonly string[]
): ModelRemovedUse[] {
  const people = new Map<string, ModelRemovedUse>(
    uses.map((use) => [use.subject, { ...use, preference: false }])
  );
  for (const subject of preferring) {
    const found = people.get(subject) ?? { subject, projects: 0, chats: 0, agents: 0 };
    people.set(subject, { ...found, preference: true });
  }
  return [...people.values()].sort((a, b) =>
    a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0
  );
}

/** Tell each of `people` their model changed; resolves once the notes are written. */
export async function notifyModelRemoved(input: {
  actorSubject: string;
  label: string;
  replacementLabel: string | null;
  people: ModelRemovedUse[];
}): Promise<void> {
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  await Promise.all(
    input.people.map(async (person) => {
      const headline = modelRemovedHeadline({ ...input, ...person });
      const id = randomUUID();
      try {
        await getDataStore().notifications.insert({
          id,
          subject: person.subject,
          kind: MODEL_REMOVED_KIND,
          category: null,
          connector: null,
          tool: null,
          entity: null,
          headline,
          refUrl: null,
          agentId: null,
          agentName: null,
          runId: null,
          meta: null,
        });
      } catch (error) {
        const reader = await whoIs(person.subject);
        logger.warn(
          '{actor} removed the LLM model "{label}", but the note telling {reader} their model changed could not be written; they were not notified: {error}',
          {
            component: 'agents/model-removed-notification',
            ...(await whoIs(input.actorSubject)),
            label: input.label,
            reader: reader.actor,
            readerSubject: reader.subject,
            readerEmail: reader.email,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return;
      }
      if (keyResult.ok) {
        void sendPush(
          person.subject,
          keyResult.val,
          {
            title: 'Your model changed',
            body: headline,
            tag: id,
            refUrl: null,
            notificationId: id,
          },
          {
            log: (message, meta) =>
              logger.warn(message, { component: 'agents/model-removed-notification', ...meta }),
          }
        );
      }
    })
  );
}
