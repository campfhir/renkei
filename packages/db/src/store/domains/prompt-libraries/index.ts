import { defineDomain } from '../../domain';
import { memoryPromptLibraries } from './memory';
import { postgresPromptLibraries } from './postgres';

export const promptLibraries = defineDomain({
  postgres: postgresPromptLibraries,
  memory: memoryPromptLibraries,
});
export type * from './types';
