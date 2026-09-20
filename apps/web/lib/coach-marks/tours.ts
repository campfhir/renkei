import type { CoachMarkTour } from './types';

/**
 * The registry: every tour this build ships, in the order they are offered.
 *
 * Order matters twice. On a page that several auto-start tours match, the
 * first unseen one wins (and only one runs per page load — the next waits
 * for the next visit). And the Tutorials page lists them in this order, so
 * the welcome tour leads.
 *
 * Copy is product text: short, second person, one idea per step. A step's
 * body should still make sense with the spotlight missing, because on a
 * phone the menu column is a drawer and the card falls back to the centre.
 *
 * Adding a tour for a new feature: anchors on the feature's elements
 * (anchors.ts), a tour here, and the tour test does the rest. Reworking a
 * feature its tour describes: bump `version`.
 */

/** A thread — '/chat/<id>' — where the composer is; not the list, projects, prompts or memory. */
const isChatThread = (path: string): boolean =>
  path.startsWith('/chat/') &&
  !['/chat/projects', '/chat/prompts', '/chat/memory', '/chat/new'].some((other) =>
    path.startsWith(other)
  );

export const COACH_MARK_TOURS: CoachMarkTour[] = [
  {
    id: 'welcome',
    version: 1,
    title: 'Welcome to Renkei',
    description:
      'A first look around: the home feed, the menu, chat, and where your settings live.',
    startPath: '/',
    autoStart: true,
    matches: (path) => path === '/',
    audience: 'everyone',
    steps: [
      {
        id: 'intro',
        title: 'Welcome to Renkei',
        body: 'Renkei connects the tools your organization already uses and acts in them as you. This short tour shows you where things are. You can skip it now and replay it any time from your account menu.',
      },
      {
        id: 'feed',
        title: 'Your home feed',
        target: 'home-feed',
        placement: 'bottom',
        body: 'Suggestions from your connected tools land here as cards. Approving a card carries out the action under your own account; archive what you do not need.',
      },
      {
        id: 'workspace',
        title: 'The workspace',
        target: 'nav-workspace',
        placement: 'right',
        body: 'Agents are step-by-step helpers you draft yourself. Knowledge searches what Renkei has indexed for you, and Files browses the shares you have connected.',
      },
      {
        id: 'chat',
        title: 'Chat with your tools',
        target: 'nav-chat',
        placement: 'right',
        body: 'Start a chat to ask questions and get things done across your connectors. Projects group chats, prompt libraries hold reusable prompts, and Memory keeps what the assistant has learned about you.',
      },
      {
        id: 'account',
        title: 'Your account menu',
        target: 'nav-account',
        placement: 'bottom',
        body: 'Notifications, preferences, connectors and your usage live behind your avatar, along with Tutorials, where you can replay this tour or start another.',
      },
      {
        id: 'done',
        title: 'That is the lay of the land',
        body: 'Other pages have short tours of their own the first time you visit. Find them all under Tutorials in your account menu.',
      },
    ],
  },
  {
    id: 'agents',
    version: 1,
    title: 'Agents',
    description: 'How to create an agent, import one, and what each listed agent can do.',
    startPath: '/agents',
    autoStart: true,
    matches: (path) => path === '/agents',
    audience: 'everyone',
    steps: [
      {
        id: 'new',
        title: 'Make a new agent',
        target: 'agents-new',
        placement: 'bottom',
        body: 'An agent is a sequence of steps you write in plain words: search these issues, pick the actionable ones, file a ticket. It runs on your own connections and on triggers you set.',
      },
      {
        id: 'import',
        title: 'Or bring one in',
        target: 'agents-import',
        placement: 'bottom',
        body: 'Import an agent a colleague exported, then adjust it as your own.',
      },
      {
        id: 'list',
        title: 'Your agents',
        target: 'agents-list',
        placement: 'top',
        body: 'Each card shows what the agent does and when it runs. Use the switch to pause it, and the icons to run it now, edit its steps, or open its run history.',
      },
    ],
  },
  {
    id: 'chat',
    version: 1,
    title: 'Chat',
    description:
      'The composer: what to type, which tools the assistant may use, and the model it runs on.',
    startPath: '/chat/new',
    autoStart: true,
    matches: isChatThread,
    audience: 'everyone',
    steps: [
      {
        id: 'composer',
        title: 'Ask in plain words',
        target: 'chat-composer',
        placement: 'top',
        body: 'Type what you need. Enter sends, Shift+Enter starts a new line, and a slash opens your prompt libraries.',
      },
      {
        id: 'tools',
        title: 'Which tools it may use',
        target: 'chat-tools',
        placement: 'top',
        body: 'The assistant reaches into your connectors through tools. Narrow the set for a chat here; your default set is under Preferences.',
      },
      {
        id: 'model',
        title: 'Pick a model',
        target: 'chat-model',
        placement: 'top',
        body: 'Each chat runs on one model. Switch it here, and turn on extended thinking for a harder question.',
      },
      {
        id: 'send',
        title: 'Send it',
        target: 'chat-send',
        placement: 'top',
        body: 'The reply streams in below. While it is running, Send queues your next message and Stop ends the turn.',
      },
    ],
  },
  {
    id: 'connectors',
    version: 1,
    title: 'Connectors',
    description: 'Connecting your own accounts, and the endpoint your LLM app talks to.',
    startPath: '/connectors',
    autoStart: true,
    matches: (path) => path === '/connectors',
    audience: 'everyone',
    steps: [
      {
        id: 'add',
        title: 'Connect your accounts',
        target: 'connectors-add',
        placement: 'bottom',
        body: 'Pick the tools you work with. Each one connects with your own credentials, so everything Renkei does in it happens as you and sees only what you can see.',
      },
      {
        id: 'endpoint',
        title: 'Your MCP endpoint',
        target: 'connectors-endpoint',
        placement: 'bottom',
        body: 'Paste this URL into an LLM app that speaks MCP and it gains the same tools, with the same permissions, as your chat here.',
      },
    ],
  },
  {
    id: 'admin',
    version: 1,
    title: 'The organization console',
    description: 'For operators: what each area of the console is for.',
    startPath: '/admin',
    autoStart: true,
    matches: (path) => path === '/admin',
    audience: 'operators',
    steps: [
      {
        id: 'areas',
        title: 'Everything an operator configures',
        target: 'admin-sections',
        placement: 'top',
        body: 'Connections hold app registrations and credentials; Agents oversees every agent in the organization; Usage and the records below show who is doing what. Tutorials, under People and records, reports on who has taken these tours.',
      },
    ],
  },
];

export function tourById(id: string): CoachMarkTour | null {
  return COACH_MARK_TOURS.find((tour) => tour.id === id) ?? null;
}
