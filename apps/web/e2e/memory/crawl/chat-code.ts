import { field, send, type CrawlPage, type CrawlStage } from './types';

/**
 * Chat and code pages. Chats, projects, prompt libraries and memory notes
 * are made through the chat's own routes — sealed under keys the
 * in-process delegate holds, so each page reads them back in the clear.
 * Artifacts come from uploads and chat turns, and a code project needs a
 * GitHub or Bitbucket connection (a vendor's OAuth): those pages show
 * their empty states, and a code project's own pages are not crawled.
 */

/** A chat project of the crawl's person, with one chat in it named "Crawl chat". */
async function chatInProject({ api }: CrawlStage): Promise<{ projectId: string; chatId: string }> {
  const projectId = field(
    await send(api, 'post', '/api/chat/projects', {
      name: 'Crawl chat project',
      description: 'A project the crawl staged',
    }),
    'projectId'
  );
  const chatId = field(await send(api, 'post', '/api/chat/chats', { projectId }), 'chatId');
  await send(api, 'patch', `/api/chat/chats/${chatId}`, { title: 'Crawl chat' });
  return { projectId, chatId };
}

async function library({ api }: CrawlStage): Promise<string> {
  const libraryId = field(
    await send(api, 'post', '/api/chat/prompt-libraries', { name: 'Crawl library' }),
    'libraryId'
  );
  await send(api, 'post', `/api/chat/prompt-libraries/${libraryId}/prompts`, {
    title: 'Crawl prompt',
    body: 'Say hello to the crawl.',
  });
  return libraryId;
}

export const chatCodePages: CrawlPage[] = [
  {
    // The index opens the newest chat.
    path: '/chat',
    stage: async (stage) => {
      await chatInProject(stage);
    },
    expectText: 'Crawl chat',
  },
  // A new chat is made and opened.
  { path: '/chat/new' },
  {
    path: '/chat/[chatId]',
    stage: async (stage) => `/chat/${(await chatInProject(stage)).chatId}`,
    expectText: 'Crawl chat',
  },
  {
    path: '/chat/projects',
    stage: async (stage) => {
      await chatInProject(stage);
    },
    expectText: 'Crawl chat project',
  },
  {
    path: '/chat/projects/[projectId]',
    stage: async (stage) => `/chat/projects/${(await chatInProject(stage)).projectId}`,
    expectText: 'Crawl chat project',
  },
  {
    path: '/chat/prompts',
    stage: async (stage) => {
      await library(stage);
    },
    expectText: 'Crawl library',
  },
  {
    path: '/chat/prompts/[libraryId]',
    stage: async (stage) => `/chat/prompts/${await library(stage)}`,
    expectText: 'Crawl prompt',
  },
  {
    path: '/chat/memory',
    stage: async ({ api }) => {
      await send(api, 'post', '/api/chat/memory', { content: 'Crawl memory note' });
    },
    expectText: 'Crawl memory note',
  },
  { path: '/chat/artifacts', expectText: 'Files you upload and files chats generate' },
  { path: '/code', expectText: 'A code project is a repository' },
  { path: '/code/new' },
  { path: '/files', expectText: 'Files' },
];
