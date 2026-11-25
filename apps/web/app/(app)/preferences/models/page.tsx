import React from 'react';
import { redirect } from 'next/navigation';
import { getChatModelPrefs, getImagePrefs } from '@renkei/user-prefs';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listChatModels, listImageModels } from '@/lib/chat/models';
import { PreferencesSectionBody } from '../section-body';
import ChatModelForm from '../chat-model-form';
import ImageModelForm from '../image-model-form';

/** Preferences › Models: which model a new chat starts on, and which one draws images. */
export default async function ModelsPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/models`));
  const [chatModelPrefs, chatModels, imagePrefs, imageModels] = await Promise.all([
    getChatModelPrefs(session.subject, { fresh: true }),
    // The organization's default first; empty when it has no chat model.
    listChatModels().catch(() => []),
    getImagePrefs(session.subject, { fresh: true }),
    // Empty when the org has no image generation model.
    listImageModels().catch(() => []),
  ]);
  return (
    <PreferencesSectionBody
      title="Models"
      description="Which model a new chat starts on, and which one draws images."
    >
      {chatModels.length > 0 ? (
        <ChatModelForm initial={chatModelPrefs} models={chatModels} />
      ) : null}
      {imageModels.length > 0 ? <ImageModelForm initial={imagePrefs} models={imageModels} /> : null}
      {chatModels.length === 0 && imageModels.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Your organization has no models to choose between yet.
        </p>
      ) : null}
    </PreferencesSectionBody>
  );
}
