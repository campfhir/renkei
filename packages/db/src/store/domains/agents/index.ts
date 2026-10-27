import { defineDomain } from '../../domain';
import { memoryAgents } from './memory';
import { postgresAgents } from './postgres';

export const agents = defineDomain({
  postgres: postgresAgents,
  memory: memoryAgents,
});
export type * from './types';
