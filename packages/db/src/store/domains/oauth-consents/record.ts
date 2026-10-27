import type { Selectable } from 'kysely';
import type {
  OauthAuthorizationCodes,
  OauthClients,
  OauthConsentRequests,
} from '../../../db.types';
import type {
  AuthorizationCodeRecord,
  ConsentRequestRecord,
  NewOAuthClient,
  NewPendingSignin,
  OAuthClientRecord,
} from './types';

export function authorizationCodeFromRow(
  row: Selectable<OauthAuthorizationCodes>
): AuthorizationCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    subject: row.subject,
    scope: row.scope,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    roles: row.roles ?? [],
    expiresAt: new Date(row.expires_at),
  };
}

export function clientValues(client: NewOAuthClient) {
  return {
    client_id: client.clientId,
    client_secret_hash: client.secretHash,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    response_types: client.responseTypes,
    grant_types: client.grantTypes,
  };
}

export function pendingSigninValues(signin: NewPendingSignin) {
  return {
    id: signin.id,
    state: signin.state,
    nonce: signin.nonce,
    subject: signin.subject,
    scopes: signin.scopes,
    provider: signin.provider ?? null,
    code_verifier: signin.codeVerifier ?? null,
    expires_at: signin.expiresAt,
    created_at: signin.createdAt,
  };
}

export function clientFromRow(row: Selectable<OauthClients>): OAuthClientRecord {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    createdAt: new Date(row.created_at),
  };
}

export function requestFromRow(row: Selectable<OauthConsentRequests>): ConsentRequestRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    sessionId: row.session_id,
    subject: row.subject,
    redirectUri: row.redirect_uri,
    state: row.state,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    expiresAt: new Date(row.expires_at),
  };
}

export function requestValues(request: ConsentRequestRecord) {
  return {
    id: request.id,
    client_id: request.clientId,
    session_id: request.sessionId,
    subject: request.subject,
    redirect_uri: request.redirectUri,
    state: request.state,
    scope: request.scope,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    expires_at: request.expiresAt,
  };
}

export function codeValues(code: import('./types').NewAuthorizationCode) {
  return {
    code: code.code,
    client_id: code.clientId,
    subject: code.subject,
    scope: code.scope,
    redirect_uri: code.redirectUri,
    code_challenge: code.codeChallenge,
    code_challenge_method: code.codeChallengeMethod,
    roles: code.roles,
    expires_at: code.expiresAt,
  };
}
