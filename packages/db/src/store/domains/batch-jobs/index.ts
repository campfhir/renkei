import { defineDomain } from '../../domain';
import { memoryBatchJobs } from './memory';
import { postgresBatchJobs } from './postgres';

export const batchJobs = defineDomain({ postgres: postgresBatchJobs, memory: memoryBatchJobs });
export type * from './types';
