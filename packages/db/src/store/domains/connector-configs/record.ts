import type { Selectable } from 'kysely';
import type { ConnectorConfigs } from '../../../db.types';
import type { ConnectorConfigRecord } from './types';

export function connectorConfigFromRow(row: Selectable<ConnectorConfigs>): ConnectorConfigRecord {
  return {
    connector: row.connector,
    enabled: row.enabled,
    settings: row.settings ?? null,
    encryptedSecrets: row.encrypted_secrets,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
