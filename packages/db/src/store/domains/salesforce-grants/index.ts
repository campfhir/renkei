import { defineDomain } from '../../domain';
import { memorySalesforceGrants } from './memory';
import { postgresSalesforceGrants } from './postgres';

export const salesforceGrants = defineDomain({
  postgres: postgresSalesforceGrants,
  memory: memorySalesforceGrants,
});
export type * from './types';
