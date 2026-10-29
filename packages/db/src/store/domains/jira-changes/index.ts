import { defineDomain } from '../../domain';
import { memoryJiraChanges } from './memory';
import { postgresJiraChanges } from './postgres';

export const jiraChanges = defineDomain({
  postgres: postgresJiraChanges,
  memory: memoryJiraChanges,
});
export type * from './types';
