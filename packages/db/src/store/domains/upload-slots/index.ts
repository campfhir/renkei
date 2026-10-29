import { defineDomain } from '../../domain';
import { memoryUploadSlots } from './memory';
import { postgresUploadSlots } from './postgres';

export const uploadSlots = defineDomain({
  postgres: postgresUploadSlots,
  memory: memoryUploadSlots,
});
export type * from './types';
