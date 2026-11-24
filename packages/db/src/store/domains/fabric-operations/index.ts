import { defineDomain } from '../../domain';
import { memoryFabricOperations } from './memory';
import { postgresFabricOperations } from './postgres';

export const fabricOperations = defineDomain({
  postgres: postgresFabricOperations,
  memory: memoryFabricOperations,
});
export type * from './types';
