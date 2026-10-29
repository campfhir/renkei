import type { Selectable } from 'kysely';
import type { OauthAccessTokens } from '../../../db.types';
import type { NewRunToken, RunTokenRecord } from './types';

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
    sandboxScope: row.sandbox_scope ?? null,
    expiresAt: new Date(row.expires_at),
  };
}

export function runTokenValues(token: NewRunToken) {
  return {
    token_hash: token.tokenHash,
    client_id: token.clientId,
    subject: token.subject,
    application: token.application,
    agent_id: token.agentId,
    scope: token.scope,
    ...(token.roles ? { roles: token.roles } : {}),
    tool_names: token.toolNames,
    sandbox_scope: token.sandboxScope ?? null,
    expires_at: token.expiresAt,
  };
}
