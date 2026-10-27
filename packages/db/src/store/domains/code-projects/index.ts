import { defineDomain } from '../../domain';
import { memoryCodeProjects } from './memory';
import { postgresCodeProjects } from './postgres';

export const codeProjects = defineDomain({
  postgres: postgresCodeProjects,
  memory: memoryCodeProjects,
});
export type * from './types';
