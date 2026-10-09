# Per-user encryption keys and the chat key store

How a person's chats and connector credentials are sealed under keys of their own, how a shared chat is opened by more than one person without the content moving, and how a person brings a key of their own that the server cannot derive. Migrations 133 and 134; primitives in `packages/crypto/src/keys.ts`; rows in `packages/user-keys`; the chat's use of it in `apps/web/lib/chat/chat-keys.ts`; the person's controls on the preferences page.

## The problem

Before this, everything at rest was under one key per deployment: provider tokens and connector credentials under `TOKEN_ENCRYPTION_KEY`, chat content under the `renc1` content envelope (`CONTENT_ENCRYPTION_KEY`, falling back to the same token key). Three consequences:

- A person's data had no key of its own. Nothing could be rotated or revoked for one person; a leak of the one key was a leak of everyone's.
- Sharing a chat was only a row in `resource_access_grants`. The grantee's ability to read the bytes rested entirely on the application checking that row — nothing cryptographic followed the decision.
- There was no way to say "this chat's key is held by these three people": a chat had no key.

Those forms are **retired**. No reader in the web app or a worker opens a `renc1` row or a deployment-key credential any more; the one program that still reads them is the rollout sweep, whose job is to move them (see "Rollout" — it must run before the strict readers deploy).

## The hierarchy

```
 master (deployment secret)                      — or —   passphrase (the person's own)
   │  HKDF-SHA256(master, salt_user,                        │  scrypt(passphrase, salt_user), then
   │    "renkei/user-kek/v1" ‖ tenant ‖ subject)            │  HKDF(…, "renkei/user-kek-own/v1" ‖ tenant ‖ subject)
   ▼                                                        ▼
 KEK_user  (never stored; the salt is — user_encryption_keys.mode says which derivation)
   │  secretbox-wrap
   ▼
 DEK_resource  (32 random bytes per chat / project; stored only wrapped — resource_key_grants, one row per holder)
   │  secretbox
   ▼
 renc2:<key id>:v1.<iv>.<tag>.<ciphertext>    on every row the resource owns
```

> **Superseded in part.** Since phases 2–5 of [`delegate-key-design.md`](./delegate-key-design.md) a person's key-encryption key is the user key their browser holds, not a derivation from a master; the resource keys, envelopes and sharing model below are unchanged, the "Your own key" passphrase section is retired, and the master is a migration-only aid. Read that document first.

**Master.** `USER_KEY_ENCRYPTION_KEY`, with no fallback, set on exactly one process: the delegate (`apps/worker-delegate`, [`delegate-key-design.md`](./delegate-key-design.md)). Every other process asks the delegate for the one key its request needs — a chat's or project's data key — and never derives a person's key itself.

**A person's managed KEK** is derived from the master, a random 32-byte salt kept for them in `user_encryption_keys`, and their identity (tenant id, OIDC subject) as the HKDF info. It is recomputed on every use and written nowhere. The salt is what makes it rotatable: `rotateUserKek` writes a new salt and, in the same transaction, rewraps everything the person holds — every `resource_key_grants` row and every `uenc1:` value in the registry `SEALED_FOR_SUBJECT` names (provider tokens, the three credential tables, personal memory) — bumping `version` so a wrapping says which KEK it is under. Deleting the row (`shredUserKek`) makes every wrapping for that person, and every value sealed directly under their KEK, unopenable at once.

**A resource's DEK** is minted when the resource is created (`createChat` and `createProject` → `createKey`), wrapped for its owner. It exists at rest only wrapped. `resource_keys` is the resource ↔ key relationship (one row per chat or project; `resource_kind` + `resource_id`, polymorphic like `resource_access_grants`); `resource_key_grants` is the set of people who can open it (`wrapped_key` under each person's KEK, `granted_by` for the sharer, `kek_version`).

**Content** under the DEK carries the key id in the envelope, so a reader knows which key a row wants before it tries, and a row sealed under another key is reported as such rather than as an opaque failure.

## What is keyed, and under what

One rule: a row is sealed under the key of the thing it belongs to, and under nothing else.

| Rows                                                                                                                     | Key               | Envelope |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------- | -------- |
| `chat_messages.content`, `chat_summaries.content`, `chat_subagent_runs.{task,instructions,transcript,report}`            | the chat's DEK    | `renc2`  |
| `chat_attachments.extracted_text` for a file in a chat                                                                   | the chat's DEK    | `renc2`  |
| `chat_projects.instructions`, `chat_project_memories.content`, `chat_attachments.extracted_text` for a file in a project | the project's DEK | `renc2`  |
| `chat_user_memories.content` (a person's own memory)                                                                     | the person's KEK  | `uenc1`  |
| `provider_grants` tokens, `mirth_instance_connections`, `admanager_instance_connections`, `file_share_connections`       | the person's KEK  | `uenc1`  |

A **project** has a key of its own kind because its instructions, its memory and its files are per project, not per chat; `resolveProjectAccess` returns the project's cipher to its members the way `resolveChatAccess` returns the chat's. A file copied between chats is re-sealed under the destination's key at copy time.

## Sharing

Sharing a chat (`POST …/chats/[chatId]/grants`) is two writes: the access grant, as before, and `shareKey` — open the DEK as the owner, wrap it for the grantee under _their_ KEK, insert the grant row. Nothing is re-encrypted; the one data key gains one more holder. Unsharing deletes the access grant and the grantee's wrapping (`revokeKey`). Deleting the chat deletes its key, and every wrapping cascades.

The access grant is the decision; the wrapping follows it. If a share's rewrap did not land (a crash between the two writes), the grantee's first read heals it: `cipherFor` sees a valid access grant with no wrapping and performs the share then.

**Connector credentials are never shared.** A provider token or a connector credential belongs to exactly one person; it is sealed directly under that person's KEK and no DEK, no grant row and no "open as the owner" path exists for it. There is nothing to rewrap for anyone else, and the worker that acts for a person opens it with that person's key or not at all.

## Who opens with what

`resolveChatAccess` returns a `cipher` with the access; every read and write of a chat's rows takes one (there is no default on the message layer, so a row cannot be written under the wrong key by omission, and there is no deployment key to fall back to). `apps/web/lib/chat/chat-keys.ts` decides who opens as whom and asks the delegate for that data key:

| Reader                                                                       | Opens as                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| The owner                                                                    | Themselves                                                 |
| A named viewer (`resource_access_grants`)                                    | Themselves, through the share's wrapping; healed if absent |
| A project member reading a fellow member's chat                              | The chat's owner                                           |
| A process with nobody signed in: a resumed turn, a worker's note, the sweeps | The chat's owner                                           |
| Search across the sidebar (`chatCiphersFor`)                                 | The viewer where they hold the key, else the owner         |

"As the owner" is possible because the delegate, holding the master, can derive any _managed_ KEK. That is the honest statement of what this design is for a person on the managed key: **key separation** — per-person keys, per-resource keys, a cryptographic sharing model, rotation and a shred for one person — and not end-to-end encryption. It is also what lets a turn resume after the process that started it is gone, and what lets a worker drop a note into a chat while its owner is away.

A row the cipher cannot open (sealed under another key, under a key that is locked, or in a retired form) renders as one text block carrying a marker rather than failing the page; the marker says which case it is, and the chat page shows a notice with a link to Preferences when the reason is a locked key (`ChatView.keyLocked`).

## Your own key

A person may replace the managed derivation with a passphrase of their own, from **Preferences → Encryption key** (`apps/web/app/(app)/preferences/encryption-key-form.tsx`, route `…/api/encryption-key`). Then the server cannot derive their KEK: it is `HKDF(scrypt(passphrase NFKC, salt), salt, "renkei/user-kek-own/v1" ‖ tenant ‖ subject)`, and the passphrase is never stored. What is stored, in `user_encryption_keys` (migration 134):

- `mode` — `managed` or `own`;
- `verifier` — `sha256(HKDF(KEK, "", "renkei/user-kek-verifier/v1"))`, so a wrong passphrase is told apart from a right one without anything sealed under the KEK being touched;
- `sealed_kek` and `unlocked_until` — the **unlock window**: for as long as the person asked (24 hours by default, 30 days at most), the KEK is kept wrapped under a master-derived unlock key (`"renkei/user-kek-unlock/v1"`) so their chats keep working, turns resume, and workers act for them while they are away from the page. When the window ends, or they lock the key, `sealed_kek` is cleared and every reader for that person gets `KEY_LOCKED`: the chat page says so and points at Preferences, connectors cannot act for them, and nothing is written for them until they unlock.

The four moves, each in one transaction (`packages/user-keys/src/kek.ts`):

| Move                 | Needs                    | Does                                                                                                                                                                                          |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adoptOwnKey`        | the (new) passphrase     | derives the new KEK, rewraps everything the person holds from the current KEK (managed, or own and unlocked), records the verifier, opens an unlock window. Also how a passphrase is changed. |
| `unlockOwnKey`       | the passphrase, a window | checks the verifier, seals the KEK for the window.                                                                                                                                            |
| `lockOwnKey`         | nothing                  | clears the window now.                                                                                                                                                                        |
| `revertToManagedKey` | the passphrase           | derives the managed KEK from a fresh salt and rewraps everything from the own KEK; nothing to remember afterwards.                                                                            |

The preferences page is blunt about the cost: a forgotten passphrase is unrecoverable, and every chat and credential sealed under it is lost. That is the point — there is no recovery path by design. A person on their own key still shares chats the same way (the grantee's wrapping is under the grantee's KEK, whatever kind it is), and still reads a fellow member's chat as its owner — if the owner's key is unlocked. The sweeps skip a locked person's rows and come back to them.

## Rollout

The readers are strict: a `renc1` row or a deployment-key credential does not open in the app, so the sweep must run **before** this build serves traffic, against the database it is going to serve. Readers of a row the sweep has not yet moved see a marker that says so, and a sealed write to a chat whose rows are unmoved still goes under the chat's key, so the sweep is safe to re-run after.

```
cd packages/user-keys
DATABASE_URL=… pnpm rekey-chats          # every chat and project: a key, and its rows under it; personal memory too
DATABASE_URL=… pnpm rekey-chats --all    # …plus provider_grants and the three credential tables
```

Batched and resumable; a row already under its target key is skipped. The sweep is the one program that still holds the retired key logic (`renc1` under `CONTENT_ENCRYPTION_KEY`/`TOKEN_ENCRYPTION_KEY`, credentials under `TOKEN_ENCRYPTION_KEY`), and the one reason those variables are still read for anything but the master chain. `chat_summaries.content` predates both envelopes and may be plaintext — the sweep seals those too. A chat shared before it had a key gets its key wrapped for everyone in `resource_access_grants`.

The orphan prune in `apps/worker-agents/src/chat-sweep.ts` removes a key whose chat or project is gone, the same way it removes an orphaned access grant.

## What is not here

- **End-to-end encryption.** On the managed key the server derives every KEK; on an own key the server holds the KEK for the unlock window. Both are a deliberate trade for turns that resume and workers that act for a person who is not on the page.
- **Rotation and shred have no UI or route.** `rotateUserKek` and `shredUserKek` are callable; what triggers them (an offboarding, an admin action) is a product decision.
- **A project-level key hierarchy.** A project's DEK seals the project's own rows; a member chat's DEK is still wrapped per person, not under the project's. `resource_keys.resource_kind` admits `prompt_library` too, for when a library's prompts want a key of their own.

## Files

| Where                                                                     | What                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/crypto/src/keys.ts`                                             | HKDF and scrypt KEK derivation, the verifier, wrap/unwrap, the `renc2` and `uenc1` envelopes, the master |
| `packages/db/src/migrations/133-user-encryption-keys`                     | `user_encryption_keys`, `resource_keys`, `resource_key_grants`                                           |
| `packages/db/src/migrations/134-user-own-keys`                            | `mode`, `verifier`, `sealed_kek`, `unlocked_until` on `user_encryption_keys`                             |
| `packages/user-keys/src/kek.ts`                                           | `getUserKek`, `ensureUserKek`, `rotateUserKek`, `shredUserKek`, adopt / unlock / lock / revert           |
| `packages/user-keys/src/resource-keys.ts`                                 | create / open / share / revoke / delete a resource's key; batch open; the orphan prune                   |
| `packages/user-keys/src/user-sealed.ts`                                   | `sealForSubject` / `openForSubject` for person-only values                                               |
| `packages/user-keys/scripts/rekey-chats.ts`                               | The rollout sweep — the one reader of the retired forms                                                  |
| `apps/web/lib/chat/content-crypto.ts`                                     | `ContentCipher`, `resourceCipher`, `userCipher`, `unavailableCipher`, the markers                        |
| `apps/web/lib/chat/chat-keys.ts`                                          | The chat's and project's use of the key store: who opens as whom, share, revoke, delete                  |
| `apps/web/lib/chat/access.ts`                                             | `ChatAccess.cipher`, `ProjectAccess.cipher`                                                              |
| `apps/web/app/(app)/preferences/encryption-key-form.tsx`                 | The person's controls; `…/api/encryption-key` behind it                                |
| `apps/web/e2e/encryption-key.spec.ts`                                     | Adopt → lock → unlock → revert in a browser, with the chat opening at every unlocked step                |
| `apps/worker/src/handlers/chat-note.ts`                                   | A worker writing into a chat under its key                                                               |
| `packages/provider-grants/src/store.ts`                                   | Tokens under the owner's key, and only there                                                             |
| `packages/connector-{mirth,admanager,fileshares}/src/user-credentials.ts` | Credentials under the owner's key, and only there                                                        |
