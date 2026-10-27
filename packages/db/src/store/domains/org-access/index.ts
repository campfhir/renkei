import { defineDomain } from '../../domain';
import { memoryOrgAccess } from './memory';
import { postgresOrgAccess } from './postgres';

export const orgAccess = defineDomain({ postgres: postgresOrgAccess, memory: memoryOrgAccess });
export type * from './types';
