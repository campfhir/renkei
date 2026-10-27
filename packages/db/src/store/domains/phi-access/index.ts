import { defineDomain } from '../../domain';
import { memoryPhiAccess } from './memory';
import { postgresPhiAccess } from './postgres';

export const phiAccess = defineDomain({
  postgres: postgresPhiAccess,
  memory: memoryPhiAccess,
});
export type * from './types';
