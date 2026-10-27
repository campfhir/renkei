import { defineDomain } from '../../domain';
import { memoryAgentRuns } from './memory';
import { postgresAgentRuns } from './postgres';

export const agentRuns = defineDomain({
  postgres: postgresAgentRuns,
  memory: memoryAgentRuns,
});
export type * from './types';
