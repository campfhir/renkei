import { defineDomain } from '../../domain';
import { memoryAdmanagerInstances } from './memory';
import { postgresAdmanagerInstances } from './postgres';

export const adManagerInstances = defineDomain({
  postgres: postgresAdmanagerInstances,
  memory: memoryAdmanagerInstances,
});
export type * from './types';
