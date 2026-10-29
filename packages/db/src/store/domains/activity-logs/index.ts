import { defineDomain } from '../../domain';
import { memoryActivityLogs } from './memory';
import { postgresActivityLogs } from './postgres';

export const activityLogs = defineDomain({
  postgres: postgresActivityLogs,
  memory: memoryActivityLogs,
});
export type * from './types';
