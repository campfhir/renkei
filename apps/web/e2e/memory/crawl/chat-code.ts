import type { TableRows } from '@renkei/db';
import type { CrawlPage } from './types';
import { crawlId } from './types';

/**
 * Fixed ids for this area's rows. Sealed content (messages, memory,
 * instructions) is seeded as opaque text: the memory suite runs without
 * the delegate, so the pages show it as unavailable — which only a seeded
 * row puts on screen.
 */
const ID = {
  chat: crawlId(201),
  chatProject: crawlId(202),
  githubProject: crawlId(203),
  bitbucketProject: crawlId(204),
  library: crawlId(205),
  prompt: crawlId(206),
  artifact: crawlId(207),
  memory: crawlId(208),
  message: crawlId(209),
  codeChat: crawlId(210),
};

const at = (minute: number) => new Date(Date.now() - (120 - minute) * 60_000);

function chatWorld(subject: string): TableRows {
  return {
    chat_projects: [
      {
        id: ID.chatProject,
        owner_subject: subject,
        name: 'Crawl chat project',
        description: 'A project the crawl seeded',
      },
      {
        id: ID.githubProject,
        owner_subject: subject,
        kind: 'code',
        name: 'Crawl GitHub project',
        repo_provider: 'github',
        repo_full_name: 'crawl/github-repo',
        repo_branch: 'main',
      },
      {
        id: ID.bitbucketProject,
        owner_subject: subject,
        kind: 'code',
        name: 'Crawl Bitbucket project',
        repo_provider: 'atlassian-bitbucket',
        repo_full_name: 'crawl/bitbucket-repo',
        repo_branch: 'main',
      },
    ],
    chats: [
      {
        id: ID.chat,
        owner_subject: subject,
        project_id: ID.chatProject,
        title: 'Crawl chat',
        last_message_at: at(100),
        updated_at: at(100),
      },
      {
        id: ID.codeChat,
        owner_subject: subject,
        project_id: ID.githubProject,
        title: 'Crawl code chat',
        last_message_at: at(90),
        updated_at: at(90),
      },
    ],
    chat_messages: [
      {
        id: ID.message,
        chat_id: ID.chat,
        seq: 1,
        role: 'user',
        kind: 'prompt',
        status: 'complete',
        content: 'sealed-by-the-crawl',
      },
    ],
  };
}

const chatOnly = (subject: string): TableRows => chatWorld(subject);

/** Pages of this area the memory crawl visits; see ./types.ts. */
export const chatCodePages: CrawlPage[] = [
  // The index opens the newest chat.
  { path: '/chat', seed: chatOnly, expectText: 'Crawl chat' },
  // A new chat is made and opened.
  { path: '/chat/new' },
  { path: `/chat/${ID.chat}`, seed: chatOnly, expectText: 'Crawl chat' },
  { path: '/chat/projects', seed: chatOnly, expectText: 'Crawl chat project' },
  { path: `/chat/projects/${ID.chatProject}`, seed: chatOnly, expectText: 'Crawl chat project' },
  {
    path: '/chat/prompts',
    seed: (subject) => ({
      prompt_libraries: [{ id: ID.library, owner_subject: subject, name: 'Crawl library' }],
    }),
    expectText: 'Crawl library',
  },
  {
    path: `/chat/prompts/${ID.library}`,
    seed: (subject) => ({
      prompt_libraries: [{ id: ID.library, owner_subject: subject, name: 'Crawl library' }],
      prompts: [
        {
          id: ID.prompt,
          library_id: ID.library,
          title: 'Crawl prompt',
          body: 'Say hello to the crawl.',
          created_by_subject: subject,
          updated_by_subject: subject,
        },
      ],
    }),
    expectText: 'Crawl prompt',
  },
  {
    path: '/chat/memory',
    seed: (subject) => ({
      chat_user_memories: [
        { id: ID.memory, owner_subject: subject, kind: 'entry', content: 'sealed-memory' },
      ],
    }),
    expectText: /content unavailable/,
  },
  {
    path: '/chat/artifacts',
    seed: (subject) => ({
      artifacts: [
        {
          id: ID.artifact,
          owner_subject: subject,
          blob_key: 'crawl/blob',
          filename: 'crawl-artifact.txt',
          content_type: 'text/plain',
          size_bytes: '42',
        },
      ],
    }),
    expectText: 'crawl-artifact.txt',
  },
  { path: '/code', seed: chatOnly, expectText: 'Crawl GitHub project' },
  { path: '/code/new' },
  { path: `/code/${ID.githubProject}`, seed: chatOnly, expectText: 'Crawl GitHub project' },
  {
    path: `/code/${ID.githubProject}/actions`,
    seed: chatOnly,
    expectText: 'Crawl GitHub project',
  },
  {
    path: `/code/${ID.githubProject}/commits`,
    seed: chatOnly,
    expectText: 'Crawl GitHub project',
  },
  {
    path: `/code/${ID.githubProject}/pulls`,
    seed: chatOnly,
    expectText: 'Crawl GitHub project',
  },
  {
    path: `/code/${ID.githubProject}/services`,
    seed: chatOnly,
    expectText: 'Crawl GitHub project',
  },
  {
    path: `/code/${ID.bitbucketProject}/pipelines`,
    seed: chatOnly,
    expectText: 'Crawl Bitbucket project',
  },
  { path: '/files', expectText: 'Files' },
];
