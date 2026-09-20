import type { CoachMarkTour } from '../types';

/** The operator console — every tour here is for operators only. */
export const ORGANIZATION_TOURS: CoachMarkTour[] = [
  {
    id: 'admin',
    area: 'Organization',
    version: 1,
    title: 'The organization console',
    description: 'For operators: what each area of the console is for.',
    startPath: '/admin',
    autoStart: true,
    requires: ['admin-sections'],
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
