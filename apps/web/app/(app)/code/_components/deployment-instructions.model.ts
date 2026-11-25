/**
 * The instructions for another tool (deployment-instructions.tsx): a
 * Markdown page a person copies into an LLM working in the project's own
 * repository, so that its deploys report to Renkei and its application
 * checks in. What it says is built from the same generators the pipeline
 * builder and the health card use (@renkei/ci-blocks report.ts,
 * health-checkins.model.ts), so the page cannot drift from what Renkei
 * accepts. It holds no secret: a token is named, never written.
 * Tested in deployment-instructions.model.test.ts. Pure: the origin is
 * passed in.
 */

import { reportSnippet, HOST_LABEL, type Host, type ReportTo } from '@renkei/ci-blocks';
import { HEALTH_PATH, HEALTH_TOKEN_VARIABLE, HEALTH_URL_VARIABLE } from '@/lib/ci/health-rules';
import { checkInExample } from './health-checkins.model';

/** Renkei's deploy report endpoint (lib/ci/report-step.ts and ci-blocks report.ts name it too). */
const REPORT_PATH = '/api/deployments/report';

export interface InstructionsInput {
  /** This Renkei's address, as the browser sees it: https://renkei.example.com. */
  origin: string;
  projectId: string;
  projectName: string;
  repoFullName: string;
  host: Host;
  /** The environment names exactly as Renkei keeps them. */
  environments: string[];
}

/** The page, or null when the origin is not an address Renkei can be reached at. */
export function deploymentInstructions(input: InstructionsInput): string | null {
  const base = input.origin.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(base)) return null;
  const to: ReportTo = { url: `${base}${REPORT_PATH}`, audience: base };
  const hostName = HOST_LABEL[input.host];
  const environments = input.environments.length
    ? input.environments.map((name) => `\`${name}\``).join(', ')
    : 'none yet: add them on the Environments page first';

  const lines: string[] = [
    `# Report deployments and health to Renkei: ${input.projectName}`,
    '',
    `Renkei (${base}) keeps track of the project **${input.projectName}**, whose repository is \`${input.repoFullName}\` on ${hostName}. Two things are optional and yours to implement in that repository:`,
    '',
    '1. **Deployment reports.** The deploy pipeline says when a deploy to an environment starts and whether it succeeded or failed.',
    '2. **Health check-ins.** The running application says how it is, on a schedule.',
    '',
    'Neither needs a Renkei login. Never commit a token or print one to a log. Keep tokens in the CI host’s secret store or the application’s environment.',
    '',
    `Environments in Renkei: ${environments}. Use these names exactly.`,
    '',
    '## 1. Deployment reports',
    '',
    `Renkei only accepts a report for a repository that one of its projects reports for. That is recorded when the project’s Pipeline tab prepares its report step, or when its pipeline is built in Renkei. Without it, Renkei answers 404.`,
    '',
    `The step POSTs JSON to \`${to.url}\` with \`Authorization: Bearer <the host’s OpenID Connect token>\`. The token names the repository, so the body needs no secret. The body:`,
    '',
    '| field | required | value |',
    '| --- | --- | --- |',
    '| `environment` | yes | the environment’s name, exactly as listed above |',
    '| `status` | yes | `started` when the deploy begins; `succeeded` or `failed` when it ends |',
    '| `commit` | yes | the commit being deployed, 7 to 64 hex characters |',
    '| `branch` | no | the branch name |',
    '| `run` | no | the run id or build number |',
    '| `target` | no | a short lowercase name for where it went, such as `eu-west` |',
    '| `detail` | no | up to 200 characters, such as an exit code |',
    '',
    'Renkei answers `200` with `{"recorded": true}`. `400` means the body is wrong, `401` that the token is missing or not valid, and `404` that no project reports for the repository. A report that cannot be sent must never fail the deploy.',
    '',
    `Add one job or step per environment, below. Put the deploy commands where the placeholder is. The report for the start runs before the deploy and the one for the end after it. ${
      input.host === 'github'
        ? 'Keep the job’s permissions, which give it the token.'
        : 'Keep `oidc: true`, which gives the step its token.'
    }`,
    '',
  ];

  for (const environment of input.environments) {
    lines.push(
      `### Deploy to \`${environment}\``,
      '',
      '```yaml',
      reportSnippet(input.host, to, environment),
      '```',
      ''
    );
  }
  if (input.environments.length === 0) lines.push('');

  lines.push(
    '## 2. Health check-ins (optional)',
    '',
    `On the Environments page of ${input.projectName}, each environment’s health card has **Set up health check-ins**. Renkei issues one token for that environment and shows it once. Store the token as the secret \`${HEALTH_TOKEN_VARIABLE}\`, and the address as \`${HEALTH_URL_VARIABLE}\` set to \`${base}${HEALTH_PATH}\`. Renkei’s **Save it for … pipeline** button can write both to the environment’s variables.`,
    '',
    `The application POSTs JSON to \`${base}${HEALTH_PATH}\` with \`Authorization: Bearer $${HEALTH_TOKEN_VARIABLE}\`. The body:`,
    '',
    '- `status` (required): one of `starting`, `healthy`, `degraded`, `error`, `stopping`.',
    '- `message` (optional): one line, up to 500 characters.',
    '- `version` (optional): a version, tag or commit, up to 120 characters.',
    '- `sentAt` (optional): when the application sent it, as an ISO 8601 time. Renkei counts from that time when it is believable.',
    '- `nextCheckInSeconds` (optional): when to expect the next check-in, from 30 to 604800. Without it, one is expected every 60 minutes.',
    '',
    'Send `starting` once the application boots, `healthy`, `degraded` or `error` on a steady rhythm shorter than the interval you state, and `stopping` on a graceful shutdown. Renkei never calls the application. A check-in that is overdue shows as potentially failing, and three missed in a row as failed. A `stopping` is not late. Answers: `200` with `{"recorded": true, "nextCheckInSeconds": …}`, `400` for a body that is wrong, `401` for a missing or wrong token, `413` for a body over 8 KB.',
    '',
    'A check-in as a command, to try the token and to copy into a script:',
    '',
    '```sh',
    checkInExample({ url: `${base}${HEALTH_PATH}` }),
    '```',
    '',
    'Make the check-in a short request with a timeout, and never let a failed check-in stop the application.'
  );

  return lines.join('\n');
}
