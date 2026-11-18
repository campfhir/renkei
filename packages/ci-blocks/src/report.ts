/**
 * "Report to Renkei": what every deploy step in a pipeline built from
 * blocks says to Renkei — that it started, then that it succeeded or
 * failed — so the Deployments page shows what runs where without anyone
 * typing it in.
 *
 * A report carries no secret. It is signed by the host: a Bitbucket step
 * with `oidc: true` holds a short-lived OpenID Connect token for itself
 * (`$BITBUCKET_STEP_OIDC_TOKEN`), and a GitHub job allowed `id-token:
 * write` asks the runner for one with Renkei as its audience. Renkei checks
 * the token against the host's published keys and learns from it which
 * repository is reporting; the body says which environment, commit and
 * target, and how it went.
 *
 * A report that cannot be sent never fails the deploy: curl's answer is
 * printed and the step goes on.
 */

import type { Host } from './render';

export interface ReportTo {
  /** Renkei's report endpoint, like https://renkei.example.com/api/deployments/report. */
  url: string;
  /** The audience a GitHub job asks its token for: Renkei's own address. */
  audience: string;
}

export const REPORT_PATH = '/api/deployments/report';

export type ReportStatus = 'started' | 'succeeded' | 'failed';

const HOST_ENV: Record<Host, { commit: string; branch: string; run: string; token: string }> = {
  bitbucket: {
    commit: '$BITBUCKET_COMMIT',
    branch: '$BITBUCKET_BRANCH',
    run: '$BITBUCKET_BUILD_NUMBER',
    token: '$BITBUCKET_STEP_OIDC_TOKEN',
  },
  github: {
    commit: '$GITHUB_SHA',
    branch: '$GITHUB_REF_NAME',
    run: '$GITHUB_RUN_ID',
    token: '$renkei_token',
  },
};

/** Single quotes for the shell; the names that reach here are letters, digits, . _ - and /. */
const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The shell that sends one report. `status` and `detail` are shell words
 * (a literal or a variable), so the finishing report can pass what the
 * step's exit code says.
 */
export function reportCommand(
  host: Host,
  to: ReportTo,
  environment: string,
  target: string | null,
  status: string,
  detail: string
): string {
  const env = HOST_ENV[host];
  const body =
    `{"environment":"${environment}","status":"${status}","commit":"${env.commit}",` +
    `"branch":"${env.branch}","run":"${env.run}","target":"${target ?? ''}","detail":"${detail}"}`;
  const lines = [
    'if command -v curl >/dev/null 2>&1; then',
    ...(host === 'github'
      ? [
          `  renkei_token=$(curl -sS "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${encodeURIComponent(to.audience)}" -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" | sed -n 's/.*"value":"\\([^"]*\\)".*/\\1/p')`,
        ]
      : []),
    `  curl -sS --max-time 15 -o /dev/null -w 'Renkei took the report (%{http_code})\\n' -X POST ${quoted(to.url)} -H "Authorization: Bearer ${env.token}" -H 'Content-Type: application/json' -d "${body.replace(/"/g, '\\"')}" || echo 'Renkei could not be reached; the deploy goes on' >&2`,
    'else',
    "  echo 'curl is not installed, so Renkei was not told of this deploy' >&2",
    'fi',
  ];
  return lines.join('\n');
}

/** Bitbucket: the exit code `after-script` sees, as a status and a detail. */
export const BITBUCKET_OUTCOME =
  'if [ "$BITBUCKET_EXIT_CODE" = 0 ]; then renkei_status=succeeded; renkei_detail=; else renkei_status=failed; renkei_detail="exit code $BITBUCKET_EXIT_CODE"; fi';

/** GitHub: the job's status (`job.status`, passed in as $RENKEI_JOB_STATUS), as a status and a detail. */
export const GITHUB_OUTCOME =
  'if [ "$RENKEI_JOB_STATUS" = success ]; then renkei_status=succeeded; renkei_detail=; else renkei_status=failed; renkei_detail="$RENKEI_JOB_STATUS"; fi';
