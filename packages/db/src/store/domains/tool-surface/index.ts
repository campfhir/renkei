import { defineDomain } from '../../domain';
import { memoryToolSurface } from './memory';
import { postgresToolSurface } from './postgres';

export const toolSurface = defineDomain({
  postgres: postgresToolSurface,
  memory: memoryToolSurface,
});
export type * from './types';
