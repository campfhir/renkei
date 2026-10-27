import { defineDomain } from '../../domain';
import { memoryIdentities } from './memory';
import { postgresIdentities } from './postgres';

export const identities = defineDomain({ postgres: postgresIdentities, memory: memoryIdentities });
export type * from './types';
