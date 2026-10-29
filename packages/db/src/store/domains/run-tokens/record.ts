import type { Selectable } from 'kysely';
import type { OauthAccessTokens } from '../../../db.types';
import type { RunTokenRecord } from './types';

export function runTokenFromRow(row: Selectable<OauthAccessTokens>): RunTokenRecord {
  return {
    tokenHash: row.token_hash,
    clientId: row.client_id,
    subject: row.subject,
    application: row.application,
    agentId: row.agent_id,
    scope: row.scope,
    roles: row.roles,
    toolNames: row.tool_names,
    expiresAt: new Date(row.expires_at),
  };
}

export function runTokenValues(token: Omit<RunTokenRecord, 'roles'> & { roles?: string[] }) {
  return {
    token_hash: token.tokenHash,
    client_id: token.clientId,
    subject: token.subject,
    application: token.application,
    agent_id: token.agentId,
    scope: token.scope,
    ...(token.roles ? { roles: token.roles } : {}),
    tool_names: token.toolNames,
    expires_at: token.expiresAt,
  };
}
