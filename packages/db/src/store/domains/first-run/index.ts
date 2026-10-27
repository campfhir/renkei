import { defineDomain } from '../../domain';
import { memoryFirstRun } from './memory';
import { postgresFirstRun } from './postgres';

export const firstRun = defineDomain({
  postgres: postgresFirstRun,
  memory: memoryFirstRun,
});
export type * from './types';
