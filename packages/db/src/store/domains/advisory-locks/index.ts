import { defineDomain } from '../../domain';
import { memoryAdvisoryLocks } from './memory';
import { postgresAdvisoryLocks } from './postgres';

export const advisoryLocks = defineDomain({
  postgres: postgresAdvisoryLocks,
  memory: memoryAdvisoryLocks,
});
export type * from './types';
