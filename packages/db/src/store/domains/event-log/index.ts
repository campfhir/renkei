import { defineDomain } from '../../domain';
import { memoryEventLog } from './memory';
import { postgresEventLog } from './postgres';

export const eventLog = defineDomain({ postgres: postgresEventLog, memory: memoryEventLog });
export type * from './types';
