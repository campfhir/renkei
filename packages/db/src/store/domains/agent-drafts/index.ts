import { defineDomain } from '../../domain';
import { memoryAgentDrafts } from './memory';
import { postgresAgentDrafts } from './postgres';

export const agentDrafts = defineDomain({
  postgres: postgresAgentDrafts,
  memory: memoryAgentDrafts,
});
export type * from './types';
