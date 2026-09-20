import type { CoachMarkTour } from '../types';

/** The first thing a newcomer sees: the shell, and where everything is. */
export const GETTING_STARTED_TOURS: CoachMarkTour[] = [
  {
    id: 'welcome',
    area: 'Getting started',
    version: 1,
    title: 'Welcome to Renkei',
    description:
      'A first look around: the home feed, the menu, chat, and where your settings live.',
    startPath: '/',
    autoStart: true,
    requires: ['home-feed'],
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
];
