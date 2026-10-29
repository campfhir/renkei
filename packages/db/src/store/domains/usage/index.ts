import { defineDomain } from '../../domain';
import { memoryUsage } from './memory';
import { postgresUsage } from './postgres';

export const usage = defineDomain({ postgres: postgresUsage, memory: memoryUsage });
export type * from './types';
