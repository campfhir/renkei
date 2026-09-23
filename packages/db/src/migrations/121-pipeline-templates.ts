import { Kysely, sql } from 'kysely';

/**
 * Pipeline templates: an org's own catalog of starting pipeline files,
 * offered on a code project's Pipelines page when the repository has no
 * `bitbucket-pipelines.yml` yet. Picking one only fills the editor — the
 * text is committed as the person leaves it — so a template is a
 * starting point to re-author, not a policy. There is no separate
 * "built-in" concept: every tenant is seeded with a few starting rows
 * below, which an operator can rename, rewrite or delete like anything
 * else in the catalog (the 115-code-project-templates idiom).
 *
 * `provider` says which host's pipeline file a template is: Bitbucket
 * today; a GitHub Actions workflow would be another row kind in the
 * same table rather than a second catalog.
 */

const BITBUCKET = 'atlassian-bitbucket';

const SEED_TEMPLATES: { name: string; description: string; body: string }[] = [
  {
    name: 'Node with pnpm',
    description: 'Install with pnpm, then lint, typecheck and test on every push.',
    body: `# Bitbucket Pipelines — Node with pnpm.
# Runs on every push. Change the image's Node version to match .nvmrc or
# package.json's engines; add a deployment step under a branch of its own.
image: node:22

definitions:
  caches:
    pnpm: ~/.local/share/pnpm/store

pipelines:
  default:
    - step:
        name: Install, lint, typecheck, test
        caches:
          - pnpm
        script:
          - corepack enable
          - pnpm install --frozen-lockfile
          - pnpm lint
          - pnpm typecheck
          - pnpm test
`,
  },
  {
    name: 'Node with npm',
    description: 'npm ci, then the project’s lint and test scripts, on every push.',
    body: `# Bitbucket Pipelines — Node with npm.
# Runs on every push. Change the image's Node version to match the
# project; add a deployment step under a branch of its own.
image: node:22

pipelines:
  default:
    - step:
        name: Install, lint, test
        caches:
          - node
        script:
          - npm ci
          - npm run lint --if-present
          - npm test
`,
  },
  {
    name: 'Python',
    description: 'A virtualenv from requirements.txt, then pytest, on every push.',
    body: `# Bitbucket Pipelines — Python.
# Runs on every push. Change the image's Python version to match the
# project; swap requirements.txt for pyproject/poetry as it uses.
image: python:3.12

pipelines:
  default:
    - step:
        name: Install and test
        caches:
          - pip
        script:
          - pip install -r requirements.txt
          - pytest
`,
  },
  {
    name: 'Bare skeleton',
    description: 'One step with one command — the shape of a pipeline, nothing assumed.',
    body: `# Bitbucket Pipelines — a skeleton to fill in.
# \`default\` runs on every push to any branch; \`branches:\` and \`tags:\`
# sections run on named ones, and \`custom:\` pipelines run only when
# started by hand (from Renkei's Pipelines page, or on Bitbucket).
image: atlassian/default-image:4

pipelines:
  default:
    - step:
        name: Build
        script:
          - echo "Replace this with the project's build and test commands."
`,
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('pipeline_templates')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('provider', 'varchar(50)', (col) => col.notNull().defaultTo(BITBUCKET))
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Names are how the page's picker and the admin catalog both refer to
  // a template, within one host's catalog.
  await db.schema
    .createIndex('idx_pipeline_templates_tenant_provider_name')
    .unique()
    .on('pipeline_templates')
    .columns(['tenant_id', 'provider', 'name'])
    .execute();

  for (const template of SEED_TEMPLATES) {
    // One INSERT…SELECT per template, cross-joined against every tenant,
    // guarded so a rerun never overwrites a row an operator rewrote.
    await sql`
      INSERT INTO pipeline_templates (id, tenant_id, provider, name, description, body)
      SELECT gen_random_uuid(), t.id, ${BITBUCKET}, ${template.name}, ${template.description}, ${template.body}
      FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM pipeline_templates existing
         WHERE existing.tenant_id = t.id
           AND existing.provider = ${BITBUCKET}
           AND existing.name = ${template.name}
      )
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pipeline_templates').execute();
}
