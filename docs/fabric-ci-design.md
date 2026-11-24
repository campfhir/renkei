# Fabric changes through CI — design

A point-in-time design doc (see [`README.md`](./README.md)); it follows
[`fabric-connector-design.md`](./fabric-connector-design.md), and the as-built description is the
`connector-fabric` section of [`connectors.md`](./connectors.md).

## What changed and why

The first Fabric connector wrote to Fabric directly: create and rename workspaces, create notebooks
and pipelines, replace their content — each behind a confirm card. Then CI and deployments landed
(building blocks, targets, a pipeline builder per code project, the Deployments page fed by each
deploy step's own OIDC-signed report). Fabric changes now follow the same road as code: a pull
request on a code project, merged to an environment's branch, deployed by that project's pipeline.

Decided with the person who asked for it:

- **Items only by pull request.** The direct create/update tools are gone. Reading, and copying
  what a workspace has into a repository, stay.
- **Workspaces through CI too.** Creating or renaming an environment's workspace is an input of its
  deploy step; the pipeline makes it so.
- **The deploy signs in with OIDC federation.** No client secret in the repository.

## Decisions

### Fabric's own git format, deployed by fabric-cicd

A repository holds items the way Fabric's git integration writes them: `<name>.<type>/` with a
`.platform` (type, display name, a logical id that makes the folder the same item in every
workspace) and the content (`notebook-content.py` in Fabric's source format,
`pipeline-content.json`). Microsoft's `fabric-cicd` deploys exactly that layout, with
per-environment parameters (`parameter.yml`) when a project needs them, so the deploy block is a
thin wrapper rather than a re-implementation of Fabric's item APIs. A replaced item keeps the
logical id its folder already had; a new one gets a fresh one.

Notebooks are stored in Fabric's source format rather than `.ipynb` because that is what Fabric's
git integration writes and what an export (`getDefinition?format=fabricGitSource`) returns — the
repository reads the same whichever way an item arrived. Jupyter JSON a person or model gives is
converted (`notebookSourceFromCells`). The converter follows the format as Fabric writes it
(`# Fabric notebook source`, `# CELL`/`# MARKDOWN`/`# METADATA` markers); it is the part most worth
checking against a real tenant.

### Two building blocks, seeded

`fabric-validate` (a check) and `fabric-deploy` (a deploy), migration 189, published as v1 by
"renkei" like the other starter blocks, so an organization edits or replaces them in the block
editor. `fabric-deploy` both ensures the workspace and publishes, rather than a separate "ensure
workspace" block: the workspace and what is deployed into it belong to the same environment and
the same identity, and one step keeps the pipeline builder's rows simple. Optional inputs default
to `none`, since a block input with an empty default is required.

### OIDC, the token the step already has

Every deploy step that reports to Renkei already holds an OIDC token (Bitbucket `oidc: true`,
GitHub `id-token: write`). The block exchanges it with Entra (`ClientAssertionCredential`) for a
Fabric token as the app registration in `AZURE_CLIENT_ID`, which needs a federated credential
trusting the repository's tokens (GitHub: subject `repo:<owner>/<name>:environment:<env>`;
Bitbucket: the workspace's OIDC issuer and its audience) and a role on the workspaces it deploys
to. That identity, not the person, creates and renames workspaces — which is why the person's
connection no longer asks for `Workspace.ReadWrite.All`.

### What the tools do

`fabric_propose_items`, `fabric_export_items` and `fabric_setup_pipeline`, each preview + confirm.
The first two commit item folders to a fresh `renkei/fabric/…` branch and open a pull request into
the first environment's branch (usually `develop`); the third saves the pipeline and opens the
pipeline builder's own pull request, so the builder page shows the same spec. Nothing in Renkei
calls a Fabric write API any more; a deploy shows on the code project's Environments page through the step's report.
