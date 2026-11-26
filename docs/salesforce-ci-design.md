# Salesforce changes through CI — design

A point-in-time design doc (see [`README.md`](./README.md)); it follows
[`salesforce-connectors-design.md`](./salesforce-connectors-design.md) and takes the road
[`fabric-ci-design.md`](./fabric-ci-design.md) took. The as-built description is the
`salesforce-admin` section of [`connectors.md`](./connectors.md).

## What changes and why

The Salesforce Admin connector writes to an org itself: a `salesforce_admin_propose_*` tool builds
a package, an operator approves the change request, and Renkei deploys it. That covers what is
built without code (objects, fields, picklists, validation rules, record types, layouts,
permission sets, report types and reports — not yet record pages, apps or promotion between orgs)
and nothing that is code: no Lightning web components, no Apex, no static resources. Code projects,
CI building blocks and the Deployments page have landed since, and Fabric already moved onto
them.

Decided with the person who asked for it:

- **The repository is the source of truth, and the pipeline is what writes to an org.** Code goes
  through CI from the start; what the connector builds follows, reports and dashboards included.
- **Change requests end as a way to ask.** Once proposals are pull requests, a change request is
  only the request in words, and that can later be an issue in Jira instead.
- **The model never holds a Salesforce credential.** It reads an org through the delegate on a
  person's own connection, as the tools do today, and it changes an org only by a pull request.

## Decisions

### A Salesforce DX project, deployed by the Salesforce CLI

A repository is a Salesforce DX project: `sfdx-project.json` at the top and source format under
`force-app/` — the layout a Salesforce developer keeps by hand and every Salesforce tool reads.
The Salesforce CLI (`sf project deploy start`) deploys it, so the deploy block is a thin wrapper
rather than a second implementation of the Metadata API.

### Branches are orgs

A code project's Environments page already assigns branches to environments. For Salesforce an
environment is an org: `develop` deploys to a sandbox, `main` to production. Promotion is a merge.

### The pipeline signs in as an integration user

Not as the person, and not with a token of Renkei's. Each org has an app (an External Client App
or connected app) and an integration user, and the pipeline reads three variables from the host:

| Variable               | Kind   | Holds                                                                |
| ---------------------- | ------ | -------------------------------------------------------------------- |
| `SF_LOGIN_URL`         | plain  | The org's My Domain address                                          |
| `SF_CLIENT_ID`         | plain  | The app's consumer key                                               |
| `SF_CLIENT_CREDENTIAL` | secret | The app's consumer secret, or the private key (PEM, or base64 of it) |

A consumer secret signs in with the client credentials flow, as the app's "run as" user. A private
key signs in with the JWT bearer flow as the user the step's `username` input names. The block
tells one from the other by the PEM header, so one block serves both and an organization picks
per org. Salesforce has no federation for a CI host's OpenID Connect token, which is why a secret
is stored at all; it is stored on the host (a Bitbucket secured variable, a GitHub secret), written
through the project's Variables page and never read back.

A check on a pull request gets only the repository's variables, so those name the org pull
requests are checked against (a sandbox). An environment's own variables name the org its deploy
step writes to.

### Two building blocks, seeded

`salesforce-validate` (a check) and `salesforce-deploy` (a deploy), migration 200, published as v1
by "renkei" like the other starter blocks. Both install a pinned Salesforce CLI on `node:22`, sign
in, and run `sf project deploy start` on the source directory; the check adds `--dry-run`, which
compiles everything and runs the tests and saves nothing. Salesforce applies a deploy whole or not
at all. `test_level` defaults to Salesforce's own rule (no tests in a sandbox, local tests in
production). Both pass `--ignore-conflicts`: the repository is what the org should hold.

Not in this version: removing from the org what the repository no longer has. The CLI deletes
only from a destructive-changes manifest, not from a source directory, so it needs a step that
works out what a merge removed.

### What keeps a credential from the model

- The sandbox image carries the Salesforce CLI for offline work on a checkout (converting pulled
  metadata to source format). Nothing signs it in to an org.
- A code project's default instructions say deploys are the pipeline's: never sign in to a
  deployment target from the checkout, never put its credentials in the project's environment.
  This is an instruction, not a block; a credential that leaks is rotated.
- A pipeline step can read the secret, so a change to the pipeline file is where it could be
  misused. Those changes arrive as pull requests a person merges, and that review is the control.

## Phases

1. **Foundations** (this change). The two blocks, the CLI in the sandbox image, Apex colouring in
   the code pane, the default instruction. The connector is unchanged.
2. **Org to repository.** A tool pulls an org's metadata through the delegate on the person's
   admin connection, puts the retrieved package in the project's checkout, and runs
   `sf project convert mdapi` there, offline, to write source format; the result is a pull
   request. A second tool sets up the pipeline. Both routes work.
3. **Proposals become pull requests.** The `salesforce_admin_propose_*` tools commit source to a
   branch and open a pull request, reports and dashboards included. A draft report in the admin's
   private folder stays direct, since that is how a report is tried against real data. Apply stops
   for what a repository holds, and "production writes: off" becomes the default.
4. **Requests only.** Change requests keep the request in words; the apply job and the review
   page go. Later, Jira.

## Open

- Language servers for Apex and Lightning web components in the code pane. The Lightning one has
  had no npm release since September 2025; the Apex one is not on npm.
- Reports people build straight in production are not in the repository. Deploys touch only the
  folders the repository holds, so they are left alone, but they are also not reviewed.
- Nothing here has run against a real org yet.
