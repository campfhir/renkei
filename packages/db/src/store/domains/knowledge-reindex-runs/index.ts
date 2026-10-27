import { defineDomain } from '../../domain';
import { memoryKnowledgeReindexRuns } from './memory';
import { postgresKnowledgeReindexRuns } from './postgres';

export const knowledgeReindexRuns = defineDomain({
  postgres: postgresKnowledgeReindexRuns,
  memory: memoryKnowledgeReindexRuns,
});
export type * from './types';
