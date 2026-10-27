import { defineDomain } from '../../domain';
import { memoryConnectorConfigs } from './memory';
import { postgresConnectorConfigs } from './postgres';

export const connectorConfigs = defineDomain({
  postgres: postgresConnectorConfigs,
  memory: memoryConnectorConfigs,
});
export type * from './types';
