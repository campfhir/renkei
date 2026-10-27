import { defineDomain } from '../../domain';
import { memoryLegacyEnvelopes } from './memory';
import { postgresLegacyEnvelopes } from './postgres';

export const legacyEnvelopes = defineDomain({
  postgres: postgresLegacyEnvelopes,
  memory: memoryLegacyEnvelopes,
});
export type * from './types';
