import { defineDomain } from '../../domain';
import { memorySealedEnvelopes } from './memory';
import { postgresSealedEnvelopes } from './postgres';

export const sealedEnvelopes = defineDomain({
  postgres: postgresSealedEnvelopes,
  memory: memorySealedEnvelopes,
});
export type * from './types';
