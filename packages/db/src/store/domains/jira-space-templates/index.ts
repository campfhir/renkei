import { defineDomain } from '../../domain';
import { memoryJiraSpaceTemplates } from './memory';
import { postgresJiraSpaceTemplates } from './postgres';

export const jiraSpaceTemplates = defineDomain({
  postgres: postgresJiraSpaceTemplates,
  memory: memoryJiraSpaceTemplates,
});
export type * from './types';
