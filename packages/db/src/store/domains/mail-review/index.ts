import { defineDomain } from '../../domain';
import { memoryMailReview } from './memory';
import { postgresMailReview } from './postgres';

export const mailReview = defineDomain({
  postgres: postgresMailReview,
  memory: memoryMailReview,
});
export type * from './types';
