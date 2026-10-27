import { defineDomain } from '../../domain';
import { memoryQueues } from './memory';
import { postgresQueues } from './postgres';

export const queues = defineDomain({
  postgres: postgresQueues,
  memory: memoryQueues,
});
export type * from './types';
