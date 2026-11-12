import { defineDomain } from '../../domain';
import { memoryArtifactBulkJobs } from './memory';
import { postgresArtifactBulkJobs } from './postgres';

export const artifactBulkJobs = defineDomain({
  postgres: postgresArtifactBulkJobs,
  memory: memoryArtifactBulkJobs,
});
export type * from './types';
