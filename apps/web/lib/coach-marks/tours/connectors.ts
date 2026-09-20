import type { CoachMarkTour } from '../types';

/** The Connectors page and each product's card. */
export const CONNECTOR_TOURS: CoachMarkTour[] = [
  {
    id: 'connectors',
    area: 'Connectors',
    version: 1,
    title: 'Connectors',
    description: 'Connecting your own accounts, and the endpoint your LLM app talks to.',
    startPath: '/connectors',
    autoStart: true,
    requires: ['connectors-add'],
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
];
