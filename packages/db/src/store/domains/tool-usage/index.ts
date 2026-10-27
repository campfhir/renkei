import { defineDomain } from '../../domain';
import { memoryToolUsage } from './memory';
import { postgresToolUsage } from './postgres';

export const toolUsage = defineDomain({
  postgres: postgresToolUsage,
  memory: memoryToolUsage,
});
export type * from './types';
