/**
 * Notifications for a spec's person, written the way the app writes them:
 * somebody else — a person of their own, signed in through ./person.ts —
 * builds agents (POST /api/agents) and shares each one with the person
 * from its access panel (POST /api/agents/:id/access). Every share lands
 * as an "… shared the agent "…" with you" notification
 * (lib/agents/share-notification.ts), in the order shared, newest last.
 *
 * Agent names are unique across the organization, so each name gets a
 * suffix of its own; the answered headline carries it. The notification
 * is written after the share answers, so this waits until the person's
 * feed (GET /api/notifications) carries each one.
 */

import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { MEMORY_BASE_URL } from '../memory/constants';
import { createPerson, type Person } from './person';

export interface SharedAgent {
  agentId: string;
  /** The notification's headline, as the person's feed shows it. */
  headline: string;
  /** The notification's id, for marking it through the feed's own route. */
  notificationId: string;
}

async function feedOf(
  request: APIRequestContext,
  person: Pick<Person, 'headers'>
): Promise<{ id: string; headline: string }[]> {
  const response = await request.get(`${MEMORY_BASE_URL}/api/notifications?limit=100`, {
    headers: person.headers,
  });
  const body: unknown = await response.json();
  const rows =
    typeof body === 'object' && body !== null && 'notifications' in body
      ? body.notifications
      : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) =>
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    typeof row.id === 'string' &&
    'headline' in row &&
    typeof row.headline === 'string'
      ? [{ id: row.id, headline: row.headline }]
      : []
  );
}

/** Share one new agent per name with `grantee`, in order; answers each notification. */
export async function shareAgentsWith(
  request: APIRequestContext,
  grantee: Pick<Person, 'subject' | 'headers'>,
  agentNames: readonly string[],
  sharerName = 'Sam Sharer'
): Promise<SharedAgent[]> {
  const sharer = await createPerson(request, { displayName: sharerName });
  const shared: { agentId: string; headline: string }[] = [];
  for (const given of agentNames) {
    const name = `${given} (${randomUUID().slice(0, 6)})`;
    const created = await request.post(`${MEMORY_BASE_URL}/api/agents`, {
      headers: sharer.headers,
      data: { name, instructions: 'Shared with a colleague.', tools: [], triggers: [] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { agentId } = await created.json();
    const granted = await request.post(`${MEMORY_BASE_URL}/api/agents/${agentId}/access`, {
      headers: sharer.headers,
      data: { granteeSubject: grantee.subject },
    });
    expect(granted.status(), await granted.text()).toBe(200);
    const headline = `${sharerName} shared the agent "${name}" with you`;
    shared.push({ agentId, headline });
    // One at a time, so the feed's order is the order shared.
    await expect
      .poll(async () => (await feedOf(request, grantee)).some((row) => row.headline === headline))
      .toBe(true);
  }
  const feed = await feedOf(request, grantee);
  return shared.map((entry) => ({
    ...entry,
    notificationId: feed.find((row) => row.headline === entry.headline)?.id ?? '',
  }));
}
