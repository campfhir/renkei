import type { CoachMarkTour } from '../types';

/** The first things a newcomer sees: the shell, where everything is, and the keyboard. */
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
  {
    id: 'shortcuts',
    area: 'Getting started',
    version: 1,
    title: 'Keyboard shortcuts',
    description:
      'Search, start a chat, or jump back to a recent chat without leaving the keyboard.',
    startPath: '/',
    autoStart: true,
    // Follows the welcome tour: same page, next in registry order.
    requires: ['home-feed'],
    audience: 'everyone',
    steps: [
      {
        id: 'search',
        title: 'Search from anywhere',
        target: 'nav-search',
        placement: 'bottom',
        body: 'Press {shortcut:search} on any page to search chats, projects and settings, then use the arrow keys and Enter to open one.',
      },
      {
        id: 'quick-chat',
        title: 'Start a chat in a flash',
        body: 'Press {shortcut:quick-chat} anywhere to open a box for your prompt. Press Enter and a new chat starts with it.',
      },
      {
        id: 'switch-chat',
        title: 'Hop between recent chats',
        body: 'Press {shortcut:switch-chat} to see your recent chats, like an app switcher. Press it again to move down the list, and Enter to open the one you want.',
      },
    ],
  },
];
