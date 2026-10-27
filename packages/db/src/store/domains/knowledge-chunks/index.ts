import { defineDomain } from '../../domain';
import { memoryKnowledgeChunks } from './memory';
import { postgresKnowledgeChunks } from './postgres';

export const knowledgeChunks = defineDomain({
  postgres: postgresKnowledgeChunks,
  memory: memoryKnowledgeChunks,
});
export type * from './types';
