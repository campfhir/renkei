/**
 * Who is reporting a deployment: the OpenID Connect token a pipeline step
 * holds, checked against the host's published keys (jose). A report
 * carries no secret Renkei handed out — the host signs for the step, and
 * the token names the repository it runs for.
 *
 * - GitHub Actions: issued by https://token.actions.githubusercontent.com
 *   (GITHUB_OIDC_ISSUER elsewhere), keys at `/.well-known/jwks`, the
 *   audience Renkei's own address (the job asks for it), the repository as
 *   `owner/name` in `repository`, and the run's commit, ref, run id and
 *   attempt, and actor beside it.
 * - Bitbucket Pipelines: issued by the workspace's
 *   `…/2.0/workspaces/{workspace}/pipelines-config/identity/oidc` on the
 *   API's own host, keys at `/keys.json`; the repository as its UUID in
 *   `repositoryUuid`. Bitbucket's default audience is the workspace's own
 *   identifier, so the audience is not what binds a token here: the
 *   signature from Bitbucket's issuer and the repository UUID are.
 *
 * Only RS256, only these issuers; any other token is refused before a key
 * is fetched.
 */

import { isRecord } from '@renkei/guards';
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { BITBUCKET_API_BASE } from '@/lib/mcp-tools/bitbucket/client';

export function githubOidcIssuer(): string {
  return (
    process.env.GITHUB_OIDC_ISSUER?.replace(/\/+$/, '') ||
    'https://token.actions.githubusercontent.com'
  );
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function bitbucketIssuer(iss: string): boolean {
  return new RegExp(
    `^${escape(BITBUCKET_API_BASE)}/workspaces/[^/?#]+/pipelines-config/identity/oidc$`
  ).test(iss);
}

export type PipelineIdentity =
  | {
      host: 'github';
      /** `owner/name`, lower case. */
      repoKey: string;
      sha: string | null;
      branch: string | null;
      run: string | null;
      actor: string | null;
    }
  | {
      host: 'bitbucket';
      /** The repository's UUID, lower case, without braces. */
      repoKey: string;
      branch: string | null;
    };

/** Where a host's keys are; tests hand in their own. */
export type KeysFor = (url: string) => JWTVerifyGetKey;

const remote = new Map<string, JWTVerifyGetKey>();
const remoteKeys: KeysFor = (url) => {
  let keys = remote.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000 });
    remote.set(url, keys);
  }
  return keys;
};

const text = (payload: JWTPayload, name: string): string | null => {
  const value = payload[name];
  return typeof value === 'string' && value
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;
};

/** A repository UUID as Bitbucket writes it, `{8f2c…}`, kept bare and lower case. */
export function bareUuid(value: string): string {
  return value.replace(/^\{|\}$/g, '').toLowerCase();
}

function refused(error: unknown): string {
  // jose's errors carry a stable code (and the claim that failed).
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const claim = isRecord(error) && typeof error.claim === 'string' ? error.claim : 'a claim';
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'The token has expired.';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return `The token’s ${claim} is not one Renkei takes.`;
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'The token’s signature does not match the host’s keys.';
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'The host has no key that signed this token.';
    default:
      return 'The token could not be checked against the host’s keys.';
  }
}

/**
 * The repository a step's token speaks for, or why it is refused.
 * `audience` is Renkei's own address, which a GitHub job asks its token for.
 */
export async function verifyPipelineToken(
  token: string,
  audience: string,
  keysFor: KeysFor = remoteKeys
): Promise<{ ok: true; identity: PipelineIdentity } | { ok: false; error: string }> {
  let iss: string | undefined;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    return { ok: false, error: 'The bearer token is not a JWT.' };
  }
  const github = githubOidcIssuer();
  try {
    if (iss === github) {
      const { payload } = await jwtVerify(token, keysFor(`${github}/.well-known/jwks`), {
        issuer: github,
        audience,
        algorithms: ['RS256'],
      });
      const repository = text(payload, 'repository');
      if (!repository) return { ok: false, error: 'The token names no repository.' };
      const ref = text(payload, 'ref');
      const runId = text(payload, 'run_id');
      const attempt = text(payload, 'run_attempt');
      return {
        ok: true,
        identity: {
          host: 'github',
          repoKey: repository.toLowerCase(),
          sha: text(payload, 'sha'),
          branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
          run: runId ? `${runId}${attempt ? `.${attempt}` : ''}` : null,
          actor: text(payload, 'actor'),
        },
      };
    }
    if (iss && bitbucketIssuer(iss)) {
      const { payload } = await jwtVerify(token, keysFor(`${iss}/keys.json`), {
        issuer: iss,
        algorithms: ['RS256'],
      });
      const repository = text(payload, 'repositoryUuid');
      if (!repository) return { ok: false, error: 'The token names no repository.' };
      return {
        ok: true,
        identity: {
          host: 'bitbucket',
          repoKey: bareUuid(repository),
          branch: text(payload, 'branchName'),
        },
      };
    }
  } catch (error) {
    return { ok: false, error: refused(error) };
  }
  return { ok: false, error: 'The token was not issued by GitHub Actions or Bitbucket Pipelines.' };
}
