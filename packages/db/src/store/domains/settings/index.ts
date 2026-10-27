import { defineDomain } from '../../domain';
import { memorySettings } from './memory';
import { postgresSettings } from './postgres';

export const settings = defineDomain({ postgres: postgresSettings, memory: memorySettings });
export type * from './types';
