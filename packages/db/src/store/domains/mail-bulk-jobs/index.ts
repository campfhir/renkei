import { defineDomain } from '../../domain';
import { memoryMailBulkJobs } from './memory';
import { postgresMailBulkJobs } from './postgres';

export const mailBulkJobs = defineDomain({
  postgres: postgresMailBulkJobs,
  memory: memoryMailBulkJobs,
});
export type * from './types';
