import { defineDomain } from '../../domain';
import { memoryLlmModels } from './memory';
import { postgresLlmModels } from './postgres';

export const llmModels = defineDomain({ postgres: postgresLlmModels, memory: memoryLlmModels });
export type * from './types';
