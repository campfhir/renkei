import { defineDomain } from '../../domain';
import { memoryAgentUsage } from './memory';
import { postgresAgentUsage } from './postgres';

export const agentUsage = defineDomain({
  postgres: postgresAgentUsage,
  memory: memoryAgentUsage,
});
export type * from './types';
