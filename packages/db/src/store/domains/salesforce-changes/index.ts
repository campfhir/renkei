import { defineDomain } from '../../domain';
import { memorySalesforceChanges } from './memory';
import { postgresSalesforceChanges } from './postgres';

export const salesforceChanges = defineDomain({
  postgres: postgresSalesforceChanges,
  memory: memorySalesforceChanges,
});
export type * from './types';
