import { defineDomain } from '../../domain';
import { memoryPlatformSettings } from './memory';
import { postgresPlatformSettings } from './postgres';

export const platformSettings = defineDomain({
  postgres: postgresPlatformSettings,
  memory: memoryPlatformSettings,
});
export type * from './types';
