import { defineDomain } from '../../domain';
import { memoryWebexDirtyWindows } from './memory';
import { postgresWebexDirtyWindows } from './postgres';

export const webexDirtyWindows = defineDomain({
  postgres: postgresWebexDirtyWindows,
  memory: memoryWebexDirtyWindows,
});
export type * from './types';
