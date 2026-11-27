import { Kysely, sql } from 'kysely';

/**
 * Two starter blocks for Salesforce, beside migrations 183's and 189's:
 * changes to a Salesforce org go through a code project's pipeline. A
 * repository is a Salesforce DX project (`sfdx-project.json`, source under
 * `force-app/` by default) and the Salesforce CLI deploys it.
 *
 *   - `salesforce-validate` (check): a check-only deploy. Salesforce
 *     compiles everything, checks every reference and runs the tests asked
 *     for, and changes nothing.
 *   - `salesforce-deploy` (deploy): the same deploy, saved. Salesforce
 *     applies it whole or not at all.
 *
 * Both sign in as the organization's integration user through an app in
 * the org, named by three variables. `SF_CLIENT_CREDENTIAL` is either the
 * app's consumer secret (the client credentials flow: the app runs as its
 * integration user) or the private key whose certificate the app holds
 * (the JWT bearer flow, with the `username` input naming the user). A key
 * is told from a secret by its PEM header, and may be given base64-encoded
 * because Bitbucket keeps a secured variable on one line.
 *
 * A check on a pull request gets the repository's variables, so those name
 * the org pull requests are checked against; an environment's own
 * variables, where it has them, name the org its deploy step writes to.
 *
 * The commands are POSIX sh (a Bitbucket step and a GitHub container job
 * both run them with sh) and use no `${…}` of the shell's own, which a
 * block reads as a placeholder.
 *
 * Seeded like 183's: published as v1 by "renkei", kept if an organization
 * already has a block with the same key. Kept here as at this migration;
 * salesforce-ci-block-seeds.test.ts checks each still reads and renders.
 */

export interface SalesforceStarterBlock {
  key: string;
  name: string;
  description: string;
  kind: string;
  definition: Record<string, unknown>;
}

/** Pinned: a deploy runs the CLI this block was published with until someone publishes another. */
const CLI_VERSION = '2.159.7';

const SIGN_IN = [
  'export SF_DISABLE_TELEMETRY=true SF_AUTOUPDATE_DISABLE=true',
  "username='${input.username}'",
  'if [ ! -f sfdx-project.json ]; then',
  "  echo 'There is no sfdx-project.json at the top of this repository, so it is not a Salesforce DX project.' >&2",
  '  exit 1',
  'fi',
  `npm install --global --no-audit --no-fund --loglevel=error @salesforce/cli@${CLI_VERSION}`,
  "login_url=$(printf '%s' \"$SF_LOGIN_URL\" | sed 's:/*$::')",
  'credential="$SF_CLIENT_CREDENTIAL"',
  // A private key given base64-encoded is decoded; a consumer secret is left as it is.
  'case "$credential" in',
  "  *'-----BEGIN '*) ;;",
  '  *)',
  '    decoded=$(printf \'%s\' "$credential" | base64 -d 2>/dev/null || true)',
  '    case "$decoded" in',
  '      *\'-----BEGIN \'*) credential="$decoded" ;;',
  '    esac',
  '    ;;',
  'esac',
  'case "$credential" in',
  "  *'-----BEGIN '*)",
  '    if [ "$username" = none ]; then',
  "      echo 'SF_CLIENT_CREDENTIAL is a private key, which signs in as one user: fill in the step’s username.' >&2",
  '      exit 1',
  '    fi',
  '    key_file=$(mktemp)',
  '    printf \'%s\\n\' "$credential" > "$key_file"',
  '    sf org login jwt --client-id "$SF_CLIENT_ID" --jwt-key-file "$key_file" --username "$username" --instance-url "$login_url" --alias target || { rm -f "$key_file"; exit 1; }',
  '    rm -f "$key_file"',
  '    ;;',
  '  *)',
  '    SF_ACCESS_TOKEN=$(SF_TOKEN_URL="$login_url/services/oauth2/token" SF_CLIENT_SECRET="$credential" node - <<\'JS\'',
  'const body = new URLSearchParams({',
  "  grant_type: 'client_credentials',",
  '  client_id: process.env.SF_CLIENT_ID,',
  '  client_secret: process.env.SF_CLIENT_SECRET,',
  '});',
  "fetch(process.env.SF_TOKEN_URL, { method: 'POST', body })",
  '  .then(async (response) => {',
  '    const text = await response.text();',
  '    let answer = {};',
  '    try {',
  '      answer = JSON.parse(text);',
  '    } catch {}',
  '    if (!response.ok || !answer.access_token) {',
  '      const why = answer.error_description || answer.error || text.slice(0, 300);',
  "      console.error('Salesforce refused the sign-in (' + response.status + '): ' + why);",
  '      process.exit(1);',
  '    }',
  '    console.log(answer.access_token);',
  '  })',
  '  .catch((error) => {',
  "    console.error('Could not reach ' + process.env.SF_TOKEN_URL + ': ' + error.message);",
  '    process.exit(1);',
  '  });',
  'JS',
  ') || exit 1',
  '    export SF_ACCESS_TOKEN',
  '    sf org login access-token --instance-url "$login_url" --alias target --no-prompt',
  '    ;;',
  'esac',
];

/** The deploy itself; `extra` is what makes it a check. */
function deployCommands(extra: string): string {
  return [
    ...SIGN_IN,
    // The repository is what the org should hold, so what changed in the org meanwhile does not stop it.
    `set -- --target-org target --source-dir '\${input.source_directory}' --wait '\${input.wait_minutes}' --ignore-conflicts${extra}`,
    "if [ '${input.test_level}' != default ]; then",
    '  set -- "$@" --test-level \'${input.test_level}\'',
    'fi',
    'sf project deploy start "$@"',
  ].join('\n');
}

const INPUTS = [
  {
    name: 'source_directory',
    type: 'text',
    default: 'force-app',
    description: 'Where the repository keeps its Salesforce source',
  },
  {
    name: 'test_level',
    type: 'text',
    default: 'default',
    description:
      'Apex tests to run: NoTestRun, RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg or RunRelevantTests; default leaves it to Salesforce (none in a sandbox, local tests in production)',
  },
  {
    name: 'username',
    type: 'text',
    default: 'none',
    description: 'The integration user to sign in as, when the credential is a private key',
  },
  {
    name: 'wait_minutes',
    type: 'number',
    default: '33',
    description: 'How long to wait for Salesforce to finish',
  },
];

const VARIABLES = [
  {
    name: 'SF_LOGIN_URL',
    secured: false,
    description: 'The org’s My Domain address, https://<name>.my.salesforce.com',
  },
  {
    name: 'SF_CLIENT_ID',
    secured: false,
    description: 'The consumer key of the app the pipeline signs in through',
  },
  {
    name: 'SF_CLIENT_CREDENTIAL',
    secured: true,
    description:
      'That app’s consumer secret, or the private key whose certificate it holds (PEM, or base64 of it)',
  },
];

function definition(kind: 'check' | 'deploy', extra: string): Record<string, unknown> {
  return {
    kind,
    runsOn: { type: 'hosted', image: 'node:22' },
    inputs: INPUTS,
    variables: VARIABLES,
    consumes: [],
    produces: [],
    caches: [{ name: 'npm', path: '~/.npm', keyFiles: [] }],
    commands: deployCommands(extra),
  };
}

export const SALESFORCE_STARTER_BLOCKS: SalesforceStarterBlock[] = [
  {
    key: 'salesforce-validate',
    name: 'Salesforce: check a deploy',
    description:
      'Signs in to the org as the integration user and runs a check-only deploy of the repository’s Salesforce source: everything is compiled and the tests run, and nothing is changed.',
    kind: 'check',
    definition: definition('check', ' --dry-run'),
  },
  {
    key: 'salesforce-deploy',
    name: 'Salesforce: deploy to an org',
    description:
      'Signs in to the environment’s org as the integration user and deploys the repository’s Salesforce source with the Salesforce CLI; Salesforce applies it whole or not at all.',
    kind: 'deploy',
    definition: definition('deploy', ''),
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const block of SALESFORCE_STARTER_BLOCKS) {
    const definition = JSON.stringify(block.definition);
    await sql`
      WITH inserted AS (
        INSERT INTO ci_blocks (key, name, description, kind, latest_version, created_by)
        VALUES (${block.key}, ${block.name}, ${block.description}, ${block.kind}, 1, 'renkei')
        ON CONFLICT (key) DO NOTHING
        RETURNING id
      )
      INSERT INTO ci_block_versions (block_id, version, definition, published_by)
      SELECT id, 1, ${definition}::jsonb, 'renkei' FROM inserted
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM ci_blocks
    WHERE created_by = 'renkei' AND key IN ('salesforce-validate', 'salesforce-deploy')
  `.execute(db);
}
