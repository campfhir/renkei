# The delegate: one process that holds keys and tokens

A design for the next step after [`user-encryption-keys-design.md`](./user-encryption-keys-design.md): no master key anywhere, a key each person holds themselves, and exactly one process, the **delegate**, that ever has a key in memory or a provider token in hand. Everything else, the web app included, handles ciphertext, plaintext in flight, and opaque handles. This document is the thing to argue over before code moves; the open decisions are collected at the end.

## What changes, in one paragraph

Today every process that holds `USER_KEY_ENCRYPTION_KEY` can derive any person's key, which is what lets a turn resume and a worker act while the person is away, and is also why a leak of that one variable plus the database is a leak of everyone's data. In the new design there is no such variable. Each person has a random key that lives in their browser and is shown to them once. When they sign in, the browser seals that key to the delegate's public key; the delegate's private key exists only in its memory. The web app forwards sealed blobs and asks the delegate to open rows, seal rows, call a provider's API, or share a key, and it never sees a key. Background work runs on a second, narrower key the person delegates for a window of their choosing, up to 30 days, renewed silently on every sign-in. If the delegate restarts, every delegation it held becomes unreadable until browsers re-seal on their next request, which they do without the person noticing.

## The pieces

```
 browser                       web app                         delegate (apps/worker-delegate)
 ───────                       ───────                         ──────────────────────────────
 user key   (IndexedDB)  ──►  never a key; forwards        ──►  X25519 private key, memory only
 X25519 private key,          sealed blobs and asks for         opens delegations, opens and
   wrapped under user key      plaintext or an API call          seals rows, holds every provider
 device key (non-extractable)                                    token, refreshes them, dials APIs
```

**The user key.** Thirty-two random bytes generated in the browser, shown once as a grouped base32 string with a checksum, written down by the person. It is the key-encryption key directly; no passphrase, no stretching. It is stored in IndexedDB wrapped under a non-extractable WebCrypto device key, so it is bound to that browser profile as far as a web app can bind anything. Sign-out leaves it on the device; "Forget this device" removes it.

**The person's keypair.** An X25519 keypair generated at enrollment. The public key is stored in the clear in `user_encryption_keys`. The private key is stored wrapped under the user key. It exists for sharing: a chat or project key is wrapped to a grantee's public key, which needs no server-derivable secret and no grantee present.

**The automation key.** A second random symmetric key per person, wrapped under the user key. Connector credentials, provider tokens and the chats that agents write into are wrapped under both the user key and the automation key. It is what a person delegates for background work, so a compromised delegate learns a person's credentials and agent chats for the delegated window, never their conversation history, memory, or shared chats.

**Resource keys.** Unchanged: one random data key per chat and per project in `resource_keys`, wrapped per holder in `resource_key_grants`, content under `renc2`, person-only values under `uenc1`. What changes is what a wrapping is under: the owner's wrapping is under their user key (or automation key), a grantee's wrapping is to their public key.

**The delegate.** A new worker on the pattern of `apps/worker-mirth`: plain `node:http`, a bearer `DELEGATE_API_KEY` as the trust boundary, the web app and the other workers as its only callers. At boot it generates an X25519 keypair, writes its public key and an instance id to `delegate_instances` with a heartbeat, and never writes the private key anywhere. It is the only process that opens a delegation, derives nothing, and the only process that ever holds a provider access or refresh token. It runs token refresh. It can run as several instances; each has its own keypair and the browser seals to all of them.

## Delegations

A delegation is a key sealed to one delegate instance's public key, stored in `key_delegations`:

| Column               | Meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `tenant_id, subject` | whose key                                                                                          |
| `instance_id`        | which delegate instance can open it                                                                |
| `scope`              | `session` or `automation`                                                                          |
| `session_id`         | for `session`: the session it lives and dies with                                                  |
| `sealed_key`         | the user key (session) or the automation key (automation), sealed box to the instance's public key |
| `expires_at`         | the session's expiry, or the automation window the person chose (30 days at most)                  |

**Session delegation** is how interactive use works. On sign-in, and again whenever the web app answers `needs-delegation`, the browser seals the user key to every live instance and posts the blobs. From then on a request carries only the session cookie; the web app asks the delegate to act "for this session", the delegate finds the matching delegation, opens it, does the work, and drops the key. Sign-out and session expiry delete the rows. A delegate restart leaves rows nothing can open; the web app notices on the first failed open and tells the browser, which re-seals. The person sees nothing.

**Automation delegation** is how anything runs while the person is away: scheduled agents, Zoom and WebEx webhook ingestion, Microsoft change notifications, repository webhooks, token refresh, compaction of agent chats. The browser seals the automation key with the expiry the person chose, renewed silently on every sign-in from a browser that holds the user key. The preferences page shows "Your agents can run until <date>. Signing in extends this." and offers revoke-all. When it lapses, the person's agents go to **paused, needs sign-in**, not disabled, and the runs that were due run on their next sign-in with a note saying why they were late.

**Routing.** The web app and the workers pick a delegate instance that is alive and holds the delegation they need; a request to an instance without it answers `needs-delegation` and the caller tries another or asks the browser. The agents worker claims a run only when some live instance holds the owner's automation delegation.

## The delegate's operations

| Op                | Caller                                       | Does                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | web app, workers                             | Opens a batch of sealed rows for a subject under a named delegation; returns plaintext.                                                                                                                                         |
| `seal`            | web app, workers                             | Seals a batch of plaintexts under a resource's key, minting and wrapping the key on first use.                                                                                                                                  |
| `api`             | web app's MCP tools, workers                 | One HTTP request to a provider on the subject's grant: the delegate opens the token, refreshes it if due, dials, and envelopes status and body back, the way the Mirth worker's `api` op does. The caller never sees the token. |
| `exchange`        | OAuth callback route                         | Exchanges an authorization code for tokens and seals them, so the web app never holds a token even at connect time.                                                                                                             |
| `credential`      | Mirth, ADManager, file-share, OnBase workers | Opens a person's stored credential for a worker that must dial a private network itself.                                                                                                                                        |
| `share`, `revoke` | grant routes                                 | Wraps a resource key to a grantee's public key under the owner's session delegation; deletes a wrapping.                                                                                                                        |
| `rewrap`          | preferences                                  | Rotation: rewraps everything a person holds from the key in one delegation to a new key sealed in the same request.                                                                                                             |
| `enroll`          | first sign-in                                | Migration: moves a person's rows from the retired managed derivation to their new key (see Migration).                                                                                                                          |
| `delegate`        | browser, via the web app                     | Stores sealed delegations; `instances` lists live public keys.                                                                                                                                                                  |

What the web app still sees: plaintext in flight. It renders chat content, builds prompts, and sends them to the model provider. That is unavoidable in a product whose point is a model reading the content. The guarantee this design makes is narrower and still strong: **nothing stored can be read by anyone who does not hold a person's key, including someone with the database and every environment variable of every process but the delegate's memory.**

## Sharing and projects

- **A chat shared with a person.** The owner's session delegation unwraps the chat key; the delegate wraps it to the grantee's public key and inserts the grant row. The grantee opens it with their private key, which their own delegation unwraps. No server-derivable key anywhere. A share requires the owner to be signed in; sharing on someone's behalf in the background is not possible by design.
- **A project.** The project key is wrapped to every member's public key. Each member chat's key is wrapped under the project key at creation, so any member opens any chat in the project. Adding a member wraps the project key to one more public key. Removing one rotates the project key, since they already hold the old one.
- **Revocation is honest.** Deleting a wrapping stops future reads. A grantee may have the data key already; full revocation is a new data key and re-sealed content.
- **Published projects** cannot be encrypted to a key only one person holds. See the decisions.

## Enrollment, migration, devices, loss

**Enrollment.** The migration marks every person as not enrolled and moves the master key into the delegate alone, out of every other process. On a person's first sign-in: the browser generates the user key, the keypair and the automation key, wraps the private key and the automation key under the user key, and posts the public key and the wrappings together with a session delegation. The delegate's `enroll` op derives their old managed key one last time, rewraps every resource key they hold and re-seals every `uenc1` value to the new keys, and marks them enrolled. The browser then shows the key once, with a confirmation step before it goes away. A person on today's passphrase-derived key types the passphrase once at enrollment instead; the delegate derives from it as it does now. When everyone has enrolled or been deleted, the master key is removed from the delegate and the derivation code is deleted.

**Another device.** The new device generates an ephemeral X25519 keypair and shows a short code derived from its public key. An enrolled device shows the pending request; the person confirms the codes match; that device seals the user key to the new device's public key and the server relays the blob. Typing the written-down key is the fallback and the recovery path.

**Rotation.** The browser generates a new user key, seals it beside the old delegation in one `rewrap` request, and the delegate rewraps every resource key and re-seals every value in one transaction. The person's keypair is unchanged, only its wrapping, so shares survive. The new key is shown once.

**Loss.** There is no recovery. An admin deletes the account; every wrapping and every value under the lost key is shredded. Chats the person shared survive, because each grantee holds a wrapping of their own.

## What runs when

| Work                                                                          | Needs                                  | When the delegation is missing                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| Reading and continuing a chat, search, sharing, preferences                   | session delegation                     | browser re-seals on the next request, silently                                        |
| A turn in progress when the browser disconnects                               | session delegation                     | continues; pauses only if the delegate restarts, resumes on the person's next request |
| Scheduled agents, webhook ingestion, token refresh, agent-chat compaction     | automation delegation                  | paused, needs sign-in; runs on the next sign-in                                       |
| Connector workers dialing private networks (Mirth, ADManager, shares, OnBase) | `credential` under either scope        | the tool answers "sign in to use this connector"                                      |
| A worker's note into a chat                                                   | automation delegation on an agent chat | queued until the delegation returns                                                   |

## Threat model, honestly

| Attacker holds                              | Reads                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The database                                | Nothing sealed. Public keys, sealed delegations nothing can open, ciphertext.                                                                                                                                                          |
| The database and every environment variable | The same. There is no master key.                                                                                                                                                                                                      |
| Code execution on the web app               | Plaintext in flight for people currently using it. No key, no token.                                                                                                                                                                   |
| Code execution on the delegate              | Every key delegated to that instance at that moment: full user keys of signed-in people, automation keys of people inside their window. Bounded in people and in time, and revocable by the person. This is the one process to harden. |
| A person's device                           | That person's data, as today.                                                                                                                                                                                                          |

What this is not: end-to-end encryption. The model provider sees every prompt, and the web app sees plaintext while it works. What it is: encryption at rest with keys the server never persists, a single hardened holder for the window a person chooses, and cryptographic sharing.

## Phases

1. **The delegate exists and holds the master alone.** New worker; `delegate_instances`; `open`, `seal`, `api`, `exchange`, `credential` ops still backed by today's managed derivation; every `getGrant` caller in the web app (nineteen files) and `apps/worker` (five) moves behind `api` or `exchange`; the connector workers take credentials from `credential`; `USER_KEY_ENCRYPTION_KEY` and `TOKEN_ENCRYPTION_KEY` leave every process but the delegate. Pure refactor, independently valuable: after it, one process holds keys and tokens.
2. **Browser-held keys and session delegations.** Enrollment, the key shown once, `key_delegations`, `needs-delegation` handling, the migration op; the web app's chat paths move from `cipherFor` to delegate calls; today's passphrase-derived own key folds into enrollment.
3. **Automation delegation.** The automation key; agents, webhooks, refresh and compaction routed through it; paused state and the preferences page (window, renewal, revoke).
4. **Keypairs and sharing.** X25519 per person; `share` to a public key; project keys to members; the owner-derivation paths deleted.
5. **Devices, rotation, deletion, and the end of the master.** Device approval, `rewrap`, account shredding, the master removed from the delegate and the derivation code deleted.

## Phase 1 as built

What the map of the code turned up, and how phase 1 answers it:

- **Tokens are consumed as bearer strings in about thirty places**, from `jiraFetch` (one choke point for some 150 Jira and JSM calls) and `graphFetch` to a raw `fetch` per connector client and two client classes (`WebexClient`, `ZoomClient`) that take a token in their constructor. Phase 1 replaces the token with an `AuthedFetch`: a function shaped like `fetch` that the delegate client builds for a grant (`grantFetch({tenantId, provider, subject})`). The delegate's `api` op attaches the token, refreshes it when due and once more on a 401, and allows only the provider's own hosts. The connector packages' fetch layers take a fetcher instead of a token.
- **Pre-authenticated URLs** (Graph upload sessions and download URLs, which carry their own credential) are fetched directly by the caller, as before; no token of ours is involved.
- **The OAuth connect flow** does its code exchange in the delegate (`oauth/exchange`); the tokens wait behind a handle for the identity calls the callback makes next (`api` with `pending`), then `grant/commit` seals them. The web app never sees a token, even at connect time.
- **OnBase** tokens come from a customer-hosted IdP that only the OnBase worker dials; the delegate asks that worker to exchange, refresh and revoke, and holds what comes back.
- **One exception remains in phase 1: git over HTTPS in the sandbox.** A code workspace clones, pulls and pushes with a `Basic` header built from the person's GitHub or Bitbucket token, sent to the sandbox worker. Routing git through the delegate (a smart-HTTP proxy the workspace clones from, with a short-lived ticket instead of a token) is designed but deferred; until then that one path still carries a token outside the delegate, and the sandbox worker is the second process that sees one.
- **Mail and calendar leave the index** (decision 3), with two things kept: the `mail.received` agent trigger, which rode on the inbox subscription the indexing created and now keeps its subscription without ingesting; and To Do tasks, which the same pipeline indexes and which this decision did not name, so they stay for now and are flagged.

### Phase 1: what runs where

| Process                                                  | Holds                                                                                                                                                            | Reaches                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/worker-delegate`                                   | `USER_KEY_ENCRYPTION_KEY` (the only process), `TOKEN_ENCRYPTION_KEY` (for the OAuth client secrets in connector config), every provider token while it is in use | the providers; the Mirth, ADManager Plus, file-share and OnBase workers |
| `apps/web`                                               | `TOKEN_ENCRYPTION_KEY` for org-wide secrets (connector configs, model keys, blob store, VAPID, OIDC); a resource's data key for the request it serves            | the delegate only, for keys, tokens and connector workers               |
| `apps/worker`, `apps/worker-agents`                      | no key; a resource's data key for the job it runs                                                                                                                | the delegate                                                            |
| connector workers (mirth, admanager, fileshares, onbase) | the credential the delegate attached to the request, for that request                                                                                            | the private network they exist for                                      |
| `apps/worker-sandbox`                                    | a git `Basic` header per workspace operation (the documented exception)                                                                                          | GitHub or Bitbucket over git                                            |

The delegate's operations as built: `resource-key/{ensure,create,open,open-many,share,revoke,delete,has,holders}`, `user-sealed/{seal,open}`, `own-key/{status,adopt,unlock,lock,revert}`, `user-key/{rotate,shred}`, `maintenance/prune-orphan-keys`, `api` (raw, streaming), `oauth/exchange`, `grant/{commit,describe,revoke,delete,git-credential}`, and `forward/<mirth|admanager|fileshares|onbase>/<op>`. Its environment: `DELEGATE_WORKER_API_KEY`, `DELEGATE_WORKER_PORT` (8096), `USER_KEY_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, and the `*_WORKER_URL` / `*_WORKER_API_KEY` pairs of the connector workers it forwards to. Every other process has `DELEGATE_WORKER_URL` and `DELEGATE_WORKER_API_KEY` and nothing of the above but its own org-secrets key.

## Decisions taken

1. **Published projects** get a shareable key of their own, wrapped to the public key of every person invited, like any project. "Published to the org" becomes "shared with everyone the owner invites"; there is no tenant-wide key.
2. **The connector workers** stay where they are for the private-network dialing, but the delegate proxies their requests: the web app and the agents talk to the delegate, which opens the person's credential and forwards the request to the Mirth, ADManager, file-share or OnBase worker with the credential attached. Those workers hold a credential only in flight, never open storage, and need no key.
3. **The knowledge index** stays org knowledge with per-read access checks, not per-person encryption. Outlook mail and calendar content leave the index, because they are personal; what the model needs from them it reads live through the person's own grant.
4. **The automation window** defaults to its maximum, 30 days.
5. **The web app sees plaintext in flight.** Prompt assembly and model calls stay in the web app; it is the person's own typing and the model's reply, and nothing stored. Moving them into the delegate is left for later if ever wanted.

A sixth, made while cutting phase 1: the web app does not hold a person's key even for a request, but it does receive **a resource's data key** from the delegate for the request it is serving, so that the content layer (`ContentCipher`, synchronous `open` and `seal` on every chat path) keeps working unchanged. A data key opens one chat or one project, which is exactly what that request is about to read anyway. Person-only values (`uenc1`) are opened and sealed by the delegate itself. Phase 1 therefore adds `resource-key` (mint, unwrap for a subject, share, revoke, delete) and `user-sealed` (open, seal) to the delegate's operations, and `open`/`seal` of rows is not an operation at all.

`TOKEN_ENCRYPTION_KEY` also seals org-wide secrets that are nobody's in particular: connector client secrets, model API keys, the blob store's account key. Those stay where they are and are not this design's concern; the variable stays in the web app for them. The user-key master, `USER_KEY_ENCRYPTION_KEY`, loses its fallback chain and is set on the delegate alone until phase 5 removes it.
