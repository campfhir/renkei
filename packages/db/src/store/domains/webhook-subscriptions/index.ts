import { defineDomain } from '../../domain';
import { memoryWebhookSubscriptions } from './memory';
import { postgresWebhookSubscriptions } from './postgres';

export const webhookSubscriptions = defineDomain({
  postgres: postgresWebhookSubscriptions,
  memory: memoryWebhookSubscriptions,
});
export type * from './types';
