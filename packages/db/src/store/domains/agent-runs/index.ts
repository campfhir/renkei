import { defineDomain } from '../../domain';
import { memoryAgentRuns } from './memory';
import { memoryAgentRunOwnership, postgresAgentRunOwnership } from './ownership';
import { postgresAgentRuns } from './postgres';

export const agentRuns = defineDomain({
  postgres: (db) => ({ ...postgresAgentRuns(db), ...postgresAgentRunOwnership(db) }),
  memory: (tables) => ({ ...memoryAgentRuns(tables), ...memoryAgentRunOwnership(tables) }),
});
export type * from './types';
export type { AgentRunOwnershipStore } from './ownership';
