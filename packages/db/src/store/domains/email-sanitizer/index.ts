import { defineDomain } from '../../domain';
import { memoryEmailSanitizer } from './memory';
import { postgresEmailSanitizer } from './postgres';

export const emailSanitizer = defineDomain({
  postgres: postgresEmailSanitizer,
  memory: memoryEmailSanitizer,
});
export type * from './types';
