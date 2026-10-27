import { defineDomain } from '../../domain';
import { memoryDeviceKeyRequests } from './memory';
import { postgresDeviceKeyRequests } from './postgres';

export const deviceKeyRequests = defineDomain({
  postgres: postgresDeviceKeyRequests,
  memory: memoryDeviceKeyRequests,
});
export type * from './types';
