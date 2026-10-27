import { defineDomain } from '../../domain';
import { memoryAgentOptimizations } from './memory';
import { postgresAgentOptimizations } from './postgres';

export const agentOptimizations = defineDomain({
  postgres: postgresAgentOptimizations,
  memory: memoryAgentOptimizations,
});
export type * from './types';
