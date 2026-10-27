import { defineDomain } from '../../domain';
import { memoryAuditEvents } from './memory';
import { postgresAuditEvents } from './postgres';

export const auditEvents = defineDomain({
  postgres: postgresAuditEvents,
  memory: memoryAuditEvents,
});
export type * from './types';
