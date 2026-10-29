import { defineDomain } from '../../domain';
import { memoryArtifacts } from './memory';
import { postgresArtifacts } from './postgres';

export const artifacts = defineDomain({
  postgres: postgresArtifacts,
  memory: memoryArtifacts,
});
export type * from './types';
