import { Kysely, sql } from 'kysely';

/**
 * Two starter blocks for Microsoft Fabric, beside migration 183's: changes
 * to Fabric go through a code project's pipeline rather than straight to
 * Fabric's API. A repository keeps its Fabric items in Fabric's own git
 * format (a `<name>.<type>/` folder each, under `fabric/` by default); the
 * Fabric connector's tools write those folders into a branch and open a
 * pull request, and merging to an environment branch deploys them.
 *
 *   - `fabric-validate` (check): every item folder has a `.platform` that
 *     names its type, a notebook its content, a pipeline its activities.
 *   - `fabric-deploy` (deploy): signs in to Entra as the deploying identity
 *     with the host's own OpenID Connect token — a federated credential on
 *     an app registration, no stored secret — makes the environment's
 *     workspace exist under its name (created, or the one named by id
 *     renamed to it, put on a capacity when one is given), then publishes
 *     the items with Microsoft's fabric-cicd.
 *
 * The deploy block reads the step's OIDC token: Bitbucket hands a deploy
 * step one as $BITBUCKET_STEP_OIDC_TOKEN, and a GitHub deploy job is
 * allowed `id-token: write`, from which the block asks for one with Entra's
 * audience (api://AzureADTokenExchange). Both are switched on for every
 * deploy step that reports to Renkei (@renkei/ci-blocks pipeline.ts).
 *
 * Seeded like 183's: published as v1 by "renkei", kept if an organization
 * already has a block with the same key. Kept here as at this migration;
 * fabric-ci-block-seeds.test.ts checks each still reads and renders.
 */

export interface FabricStarterBlock {
  key: string;
  name: string;
  description: string;
  kind: string;
  definition: Record<string, unknown>;
}

const VALIDATE = [
  "FABRIC_ITEMS='${input.items_directory}' python3 - <<'PY'",
  'import json, os, pathlib, sys',
  'root = pathlib.Path(os.environ["FABRIC_ITEMS"])',
  'if not root.is_dir():',
  '    print(f"There is no {root}/ directory, so there are no Fabric items to check.")',
  '    sys.exit(0)',
  'problems, checked = [], 0',
  'for folder in sorted(root.rglob("*")):',
  '    if not folder.is_dir() or "." not in folder.name:',
  '        continue',
  '    kind = folder.name.rsplit(".", 1)[1]',
  '    if kind not in ("Notebook", "DataPipeline", "Lakehouse", "Environment", "SemanticModel", "Report", "VariableLibrary"):',
  '        continue',
  '    checked += 1',
  '    platform = folder / ".platform"',
  '    try:',
  '        meta = json.loads(platform.read_text())["metadata"]',
  '    except Exception as error:',
  '        problems.append(f"{folder}: .platform is missing or unreadable ({error})")',
  '        continue',
  '    if meta.get("type") != kind:',
  '        problems.append(f"{folder}: .platform says {meta.get(\'type\')}, the folder says {kind}")',
  '    if kind == "Notebook" and not any(folder.glob("notebook-content.*")):',
  '        problems.append(f"{folder}: no notebook-content file")',
  '    if kind == "DataPipeline":',
  '        try:',
  '            activities = json.loads((folder / "pipeline-content.json").read_text())["properties"]["activities"]',
  '            assert isinstance(activities, list)',
  '        except Exception:',
  '            problems.append(f"{folder}: pipeline-content.json has no properties.activities list")',
  'for problem in problems:',
  '    print(problem, file=sys.stderr)',
  'print(f"Checked {checked} Fabric item(s) under {root}/: {len(problems)} problem(s).")',
  'sys.exit(1 if problems else 0)',
  'PY',
].join('\n');

const DEPLOY = [
  'pip install --quiet --disable-pip-version-check fabric-cicd azure-identity',
  // The step's own OpenID Connect token, exchanged with Entra below.
  'if [ -n "$BITBUCKET_STEP_OIDC_TOKEN" ]; then',
  '  FABRIC_FEDERATED_TOKEN="$BITBUCKET_STEP_OIDC_TOKEN"',
  'elif [ -n "$ACTIONS_ID_TOKEN_REQUEST_URL" ]; then',
  '  FABRIC_FEDERATED_TOKEN=$(curl -sS "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange" -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" | python3 -c \'import json, sys; print(json.load(sys.stdin)["value"])\')',
  'fi',
  'if [ -z "$FABRIC_FEDERATED_TOKEN" ]; then',
  "  echo 'This step has no OpenID Connect token to sign in to Fabric with; it deploys only from a pipeline that reports to Renkei.' >&2",
  '  exit 1',
  'fi',
  'export FABRIC_FEDERATED_TOKEN',
  "FABRIC_WORKSPACE_NAME='${input.workspace_name}' FABRIC_WORKSPACE_ID='${input.workspace_id}' FABRIC_CAPACITY_ID='${input.capacity_id}' FABRIC_DESCRIPTION='${input.description}' FABRIC_ITEMS='${input.items_directory}' FABRIC_ITEM_TYPES='${input.item_types}' FABRIC_REMOVE_ORPHANS='${input.remove_orphans}' FABRIC_ENVIRONMENT='${env}' python3 - <<'PY'",
  'import json, os, sys, urllib.error, urllib.request',
  'from azure.identity import ClientAssertionCredential',
  'from fabric_cicd import FabricWorkspace, publish_all_items, unpublish_all_orphan_items',
  '',
  'credential = ClientAssertionCredential(',
  '    os.environ["AZURE_TENANT_ID"], os.environ["AZURE_CLIENT_ID"], lambda: os.environ["FABRIC_FEDERATED_TOKEN"]',
  ')',
  'token = credential.get_token("https://api.fabric.microsoft.com/.default").token',
  'API = "https://api.fabric.microsoft.com/v1"',
  '',
  'def call(method, path, body=None):',
  '    data = json.dumps(body).encode() if body is not None else None',
  '    request = urllib.request.Request(API + path, data=data, method=method, headers={',
  '        "Authorization": "Bearer " + token, "Content-Type": "application/json"})',
  '    try:',
  '        with urllib.request.urlopen(request) as response:',
  '            text = response.read().decode()',
  '            return json.loads(text) if text else {}',
  '    except urllib.error.HTTPError as error:',
  '        sys.exit(f"Fabric refused {method} {path} ({error.code}): {error.read().decode()[:500]}")',
  '',
  'def given(value):',
  '    return value not in ("", "none")',
  '',
  'name = os.environ["FABRIC_WORKSPACE_NAME"]',
  'wanted_id = os.environ["FABRIC_WORKSPACE_ID"]',
  'capacity = os.environ["FABRIC_CAPACITY_ID"]',
  'description = os.environ["FABRIC_DESCRIPTION"]',
  'workspaces, path = [], "/workspaces"',
  'while path:',
  '    page = call("GET", path)',
  '    workspaces += page.get("value", [])',
  '    following = page.get("continuationUri")',
  '    path = following.replace(API, "") if following else None',
  '',
  'if given(wanted_id):',
  '    workspace = next((w for w in workspaces if w["id"] == wanted_id), None)',
  '    if workspace is None:',
  '        sys.exit(f"Workspace {wanted_id} is not one the deploying identity can see: add it to the workspace as an admin.")',
  '    change = {}',
  '    if workspace["displayName"] != name:',
  '        change["displayName"] = name',
  '    if given(description) and workspace.get("description", "") != description:',
  '        change["description"] = description',
  '    if change:',
  '        call("PATCH", "/workspaces/" + wanted_id, change)',
  '        print(f"Workspace {wanted_id} changed: {change}")',
  'else:',
  '    named = [w for w in workspaces if w["displayName"] == name]',
  '    if len(named) > 1:',
  '        sys.exit(f"More than one workspace is named {name}; give the step its id.")',
  '    if named:',
  '        workspace = named[0]',
  '    else:',
  '        body = {"displayName": name}',
  '        if given(description):',
  '            body["description"] = description',
  '        if given(capacity):',
  '            body["capacityId"] = capacity',
  '        workspace = call("POST", "/workspaces", body)',
  '        print(f"Created workspace {name} ({workspace[\'id\']}).")',
  'if given(capacity) and workspace.get("capacityId") != capacity:',
  '    call("POST", "/workspaces/" + workspace["id"] + "/assignToCapacity", {"capacityId": capacity})',
  '    print(f"Workspace {name} is on capacity {capacity}.")',
  '',
  'target = FabricWorkspace(',
  '    workspace_id=workspace["id"],',
  '    environment=os.environ["FABRIC_ENVIRONMENT"],',
  '    repository_directory=os.environ["FABRIC_ITEMS"],',
  '    item_type_in_scope=[t.strip() for t in os.environ["FABRIC_ITEM_TYPES"].split(",") if t.strip()],',
  '    token_credential=credential,',
  ')',
  'publish_all_items(target)',
  'if os.environ["FABRIC_REMOVE_ORPHANS"] == "true":',
  '    unpublish_all_orphan_items(target)',
  'print(f"Published the items under {os.environ[\'FABRIC_ITEMS\']}/ to workspace {name}.")',
  'PY',
].join('\n');

export const FABRIC_STARTER_BLOCKS: FabricStarterBlock[] = [
  {
    key: 'fabric-validate',
    name: 'Fabric: check items',
    description:
      'Every Fabric item folder (Name.Notebook, Name.DataPipeline…) has a .platform naming its type; notebooks have their content and pipelines their activities.',
    kind: 'check',
    definition: {
      kind: 'check',
      runsOn: { type: 'hosted', image: 'python:3.12' },
      inputs: [
        {
          name: 'items_directory',
          type: 'text',
          default: 'fabric',
          description: 'Where the repository keeps its Fabric items',
        },
      ],
      variables: [],
      consumes: [],
      produces: [],
      caches: [],
      commands: VALIDATE,
    },
  },
  {
    key: 'fabric-deploy',
    name: 'Fabric: deploy items to a workspace',
    description:
      'Signs in to Entra with the step’s own OpenID Connect token (a federated credential on an app registration that is an admin of the workspace — no secret), makes the workspace exist under its name — created, or the one given by id renamed — and publishes the repository’s Fabric items to it with fabric-cicd.',
    kind: 'deploy',
    definition: {
      kind: 'deploy',
      runsOn: { type: 'hosted', image: 'python:3.12' },
      inputs: [
        {
          name: 'workspace_name',
          type: 'text',
          description: 'The workspace this environment deploys to; made if there is none',
        },
        {
          name: 'workspace_id',
          type: 'text',
          default: 'none',
          description: 'An existing workspace to use and rename to the name above',
        },
        {
          name: 'capacity_id',
          type: 'text',
          default: 'none',
          description: 'The capacity the workspace runs on',
        },
        {
          name: 'description',
          type: 'text',
          default: 'none',
          description: 'The workspace’s description',
        },
        {
          name: 'items_directory',
          type: 'text',
          default: 'fabric',
          description: 'Where the repository keeps its Fabric items',
        },
        {
          name: 'item_types',
          type: 'text',
          default: 'Notebook,DataPipeline',
          description: 'The kinds of item deployed, comma-separated',
        },
        {
          name: 'remove_orphans',
          type: 'boolean',
          default: 'false',
          description: 'Remove items of those kinds the repository no longer has',
        },
      ],
      variables: [
        {
          name: 'AZURE_TENANT_ID',
          secured: false,
          description: 'The Entra directory (tenant) id',
        },
        {
          name: 'AZURE_CLIENT_ID',
          secured: false,
          description:
            'The app registration that deploys, with a federated credential trusting this repository’s OIDC tokens',
        },
      ],
      consumes: [],
      produces: [],
      caches: [{ name: 'pip', path: '~/.cache/pip', keyFiles: [] }],
      commands: DEPLOY,
    },
  },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const block of FABRIC_STARTER_BLOCKS) {
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
    WHERE created_by = 'renkei' AND key IN ('fabric-validate', 'fabric-deploy')
  `.execute(db);
}
