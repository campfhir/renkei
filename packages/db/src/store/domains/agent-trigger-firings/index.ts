import { defineDomain } from '../../domain';
import { memoryAgentTriggerFirings } from './memory';
import { postgresAgentTriggerFirings } from './postgres';

export const agentTriggerFirings = defineDomain({
  postgres: postgresAgentTriggerFirings,
  memory: memoryAgentTriggerFirings,
});
export type * from './types';
