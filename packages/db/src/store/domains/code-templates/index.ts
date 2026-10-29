import { defineDomain } from '../../domain';
import { memoryCodeTemplates } from './memory';
import { postgresCodeTemplates } from './postgres';

export const codeTemplates = defineDomain({
  postgres: postgresCodeTemplates,
  memory: memoryCodeTemplates,
});
export type * from './types';
