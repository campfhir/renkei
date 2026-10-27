import { defineDomain } from '../../domain';
import { memoryWebexSentMessages } from './memory';
import { postgresWebexSentMessages } from './postgres';

export const webexSentMessages = defineDomain({
  postgres: postgresWebexSentMessages,
  memory: memoryWebexSentMessages,
});
export type * from './types';
