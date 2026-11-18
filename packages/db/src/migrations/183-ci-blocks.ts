import { Kysely, sql } from 'kysely';

/**
 * CI building blocks: the organization's catalogue of pipeline steps,
 * each written once in a host-neutral form and rendered for Bitbucket
 * Pipelines or GitHub Actions (@renkei/ci-blocks says what a block is).
 *
 *   - `ci_blocks`: one row a block. `key` is how a pipeline names it
 *     (`deploy-systemd`, written into the pipeline file as
 *     `block: deploy-systemd@v2`); `draft` is the definition being
 *     edited, null when nothing is unpublished; `latest_version` the
 *     newest published one, 0 before the first.
 *   - `ci_block_versions`: what was published, a row a version, never
 *     changed: a pipeline built from v2 keeps v2 until someone updates it.
 *
 * Seeded with starter blocks, each published as v1 by "renkei": an
 * organization edits, republishes or deletes them like its own. Kept here
 * as they were at this migration; ci-block-seeds.test.ts checks each still
 * reads and renders.
 */

export interface StarterBlock {
  key: string;
  name: string;
  description: string;
  kind: string;
  definition: Record<string, unknown>;
}

const HEALTH_LOOP = [
  'healthy=no',
  'for i in $(seq 1 30); do',
  '  if curl -fsS "${input.health_url}" >/dev/null; then healthy=yes; break; fi',
  '  sleep 2',
  'done',
].join('\n');

export const STARTER_BLOCKS: StarterBlock[] = [
  {
    key: 'node-test',
    name: 'Node: install, lint, test',
    description: 'npm ci from the lockfile, then the lint script if there is one, then npm test.',
    kind: 'test',
    definition: {
      kind: 'test',
      runsOn: { type: 'hosted', image: 'node:22' },
      inputs: [],
      variables: [],
      consumes: [],
      produces: [],
      caches: [{ name: 'npm', path: '~/.npm', keyFiles: ['package-lock.json'] }],
      commands: 'npm ci\nnpm run lint --if-present\nnpm test',
    },
  },
  {
    key: 'node-build',
    name: 'Node: build',
    description: 'npm ci, then the build script; leaves the build output as the artifact “dist”.',
    kind: 'build',
    definition: {
      kind: 'build',
      runsOn: { type: 'hosted', image: 'node:22' },
      inputs: [],
      variables: [],
      consumes: [],
      produces: [{ name: 'dist', paths: ['dist'] }],
      caches: [{ name: 'npm', path: '~/.npm', keyFiles: ['package-lock.json'] }],
      commands: 'npm ci\nnpm run build',
    },
  },
  {
    key: 'python-test',
    name: 'Python: install and pytest',
    description:
      'Installs requirements.txt, or the project itself from pyproject.toml, then runs pytest.',
    kind: 'test',
    definition: {
      kind: 'test',
      runsOn: { type: 'hosted', image: 'python:3.12' },
      inputs: [],
      variables: [],
      consumes: [],
      produces: [],
      caches: [
        { name: 'pip', path: '~/.cache/pip', keyFiles: ['requirements*.txt', 'pyproject.toml'] },
      ],
      commands: [
        'python -m pip install --upgrade pip',
        'if [ -f requirements.txt ]; then pip install -r requirements.txt; else pip install -e .; fi',
        'pip install pytest',
        'pytest',
      ].join('\n'),
    },
  },
  {
    key: 'go-test-build',
    name: 'Go: vet, test, build',
    description:
      'go vet, go test with the race detector, then static binaries into the artifact “dist”.',
    kind: 'build',
    definition: {
      kind: 'build',
      runsOn: { type: 'hosted', image: 'golang:1.23' },
      inputs: [{ name: 'packages', type: 'text', default: './...', description: 'What to build' }],
      variables: [],
      consumes: [],
      produces: [{ name: 'dist', paths: ['dist'] }],
      caches: [{ name: 'go-mod', path: '/go/pkg/mod', keyFiles: ['go.sum'] }],
      commands: [
        'go vet ./...',
        'go test -race ./...',
        'mkdir -p dist',
        'CGO_ENABLED=0 go build -o dist/ ${input.packages}',
      ].join('\n'),
    },
  },
  {
    key: 'deploy-compose',
    name: 'Deploy with Docker Compose on a runner',
    description:
      'On the target’s machine: pull and start the Compose project, then wait for its health route; fails if it never answers.',
    kind: 'deploy',
    definition: {
      kind: 'deploy',
      runsOn: { type: 'target' },
      inputs: [
        {
          name: 'compose_file',
          type: 'text',
          default: 'docker-compose.yml',
          description: 'In the repository',
        },
        { name: 'health_url', type: 'url', description: 'Polled after it starts' },
      ],
      variables: [],
      consumes: [],
      produces: [],
      caches: [],
      commands: [
        'docker compose -f ${input.compose_file} pull',
        'docker compose -f ${input.compose_file} up -d --remove-orphans',
        HEALTH_LOOP,
        'if [ "$healthy" != yes ]; then',
        '  echo "${input.health_url} did not answer within a minute" >&2',
        '  docker compose -f ${input.compose_file} logs --tail 100',
        '  exit 1',
        'fi',
      ].join('\n'),
    },
  },
  {
    key: 'deploy-systemd',
    name: 'Deploy a service with systemd on a runner',
    description:
      'On the target’s machine: copy the “dist” artifact into a new release, restart the unit, wait for its health route, and go back to the previous release if it never answers.',
    kind: 'deploy',
    definition: {
      kind: 'deploy',
      runsOn: { type: 'target' },
      inputs: [
        { name: 'service_name', type: 'text', description: 'The systemd unit' },
        { name: 'health_url', type: 'url', description: 'Polled after the restart' },
        {
          name: 'keep_releases',
          type: 'number',
          default: '3',
          description: 'Older releases are removed',
        },
      ],
      variables: [],
      consumes: ['dist'],
      produces: [],
      caches: [],
      commands: [
        'base=/opt/${input.service_name}',
        'release=$base/releases/${commit}',
        'previous=$(readlink -f $base/current || true)',
        'install -d "$release"',
        'cp -r dist/. "$release/"',
        'ln -sfn "$release" $base/current',
        'sudo systemctl restart ${input.service_name}',
        HEALTH_LOOP,
        'if [ "$healthy" != yes ]; then',
        '  echo "${input.health_url} did not answer within a minute; going back" >&2',
        '  if [ -n "$previous" ]; then ln -sfn "$previous" $base/current; sudo systemctl restart ${input.service_name}; fi',
        '  exit 1',
        'fi',
        'ls -1dt $base/releases/* | tail -n +$((${input.keep_releases} + 1)) | xargs -r rm -rf',
      ].join('\n'),
    },
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ci_blocks')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('key', 'varchar(80)', (col) => col.notNull())
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('draft', 'jsonb')
    .addColumn('latest_version', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_by', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  // A pipeline names a block by its key.
  await db.schema.createIndex('idx_ci_blocks_key').unique().on('ci_blocks').column('key').execute();

  await db.schema
    .createTable('ci_block_versions')
    .addColumn('block_id', 'uuid', (col) =>
      col.notNull().references('ci_blocks.id').onDelete('cascade')
    )
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('definition', 'jsonb', (col) => col.notNull())
    .addColumn('published_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('published_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('ci_block_versions_pkey', ['block_id', 'version'])
    .execute();

  for (const block of STARTER_BLOCKS) {
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
  await db.schema.dropTable('ci_block_versions').execute();
  await db.schema.dropTable('ci_blocks').execute();
}
