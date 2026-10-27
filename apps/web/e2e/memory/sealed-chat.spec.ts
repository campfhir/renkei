/**
 * A chat seeded the way the turn engine writes one — its messages sealed
 * under the chat's key, the key wrapped for its owner (e2e/support/keys.ts,
 * e2e/support/voice.ts) — opens in the browser through the delegate the
 * memory server runs in-process: the person is really enrolled, their
 * session really delegated, and the page reads the reply in the clear.
 */

import { test, expect } from './fixtures';
import { VOICE_CHAT_TITLE, seedVoiceChat } from '../support/voice';

test('a sealed chat opens for its enrolled owner', async ({ page, request, person }) => {
  const reply = `The sprint lost OPS-231 and OPS-240 (${person.subject}).`;
  const { chatId } = await seedVoiceChat(request, { subject: person.subject, reply });

  await page.goto(`/chat/${chatId}`);
  await expect(page.getByText(reply)).toBeVisible();
  await expect(page.getByText('What slipped out of the OPS sprint?')).toBeVisible();
  await expect(page.getByText(VOICE_CHAT_TITLE).filter({ visible: true }).first()).toBeVisible();
  // Nothing for the KeyGuard to ask: the key is delegated for this session.
  await expect(page.getByTestId('chat-key-unavailable-notice')).toHaveCount(0);
});
