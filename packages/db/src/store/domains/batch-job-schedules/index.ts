import { defineDomain } from '../../domain';
import { memoryBatchJobSchedules } from './memory';
import { postgresBatchJobSchedules } from './postgres';

export const batchJobSchedules = defineDomain({
  postgres: postgresBatchJobSchedules,
  memory: memoryBatchJobSchedules,
});
export type * from './types';
