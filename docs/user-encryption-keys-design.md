# Per-user encryption keys and the chat key store

How a person's chats and connector credentials come to be sealed under keys of their own, and how a shared chat is opened by more than one person without the content moving. Migration 133; primitives in `packages/crypto/src/keys.ts`; rows in `packages/user-keys`; the chat's use of it in `apps/web/lib/chat/chat-keys.ts`.

## The problem

Before this, everything at rest was under one key per deployment: provider tokens and connector credentials under `TOKEN_ENCRYPTION_KEY`, chat content under the `renc1` content envelope (`CONTENT_ENCRYPTION_KEY`, falling back to the same token key). Three consequences:

- A person's data had no key of its own. Nothing could be rotated or revoked for one person; a leak of the one key was a leak of everyone's.
- Sharing a chat was only a row in `resource_access_grants`. The grantee's ability to read the bytes rested entirely on the application checking that row — nothing cryptographic followed the decision.
- There was no way to say "this chat's key is held by these three people": a chat had no key.

## The hierarchy

```
 master (deployment secret)
   │  HKDF-SHA256(master, salt_user, "renkei/user-kek/v1" ‖ tenant ‖ subject)
   ▼
 KEK_user  (never stored; the salt is — user_encryption_keys)
   │  secretbox-wrap
   ▼
 DEK_chat  (32 random bytes; stored only wrapped — resource_key_grants, one row per holder)
   │  secretbox
   ▼
 chat_messages.content, chat_summaries.content, chat_subagent_runs.{task,instructions,transcript,report}
   as  renc2:<key id>:v1.<iv>.<tag>.<ciphertext>
```

**Master.** `USER_KEY_ENCRYPTION_KEY`, else `CONTENT_ENCRYPTION_KEY`, else `TOKEN_ENCRYPTION_KEY` — the content envelope's own fallback chain, so the feature needs no new deployment configuration. Set the dedicated variable to rotate it apart from the others.

**A person's KEK** is derived from the master, a random 32-byte salt kept for them in `user_encryption_keys`, and their identity (tenant id, OIDC subject) as the HKDF info. It is recomputed on every use and written nowhere. The salt is what makes it rotatable: `rotateUserKek` writes a new salt and, in the same transaction, rewraps every key the person holds, bumping `version` so a grant row says which KEK it is under. Deleting the salt (`shredUserKek`) makes every wrapping for that person, and every value sealed directly under their KEK, unopenable at once.

**A chat's DEK** is minted when the chat is created (`createChat` → `createChatKey`), wrapped for its owner. It exists at rest only wrapped. `resource_keys` is the chat ↔ key relationship (one row per chat; `resource_kind` + `resource_id`, polymorphic like `resource_access_grants`); `resource_key_grants` is the set of people who can open it (`wrapped_key` under each person's KEK, `granted_by` for the sharer, `kek_version`).

**Content** under the DEK carries the key id in the envelope, so a reader knows which key a row wants before it tries, and a row sealed under another key is reported as such rather than as an opaque failure.

## Sharing

Sharing a chat (`POST …/chats/[chatId]/grants`) is two writes: the access grant, as before, and `shareChatKey` — open the DEK as the owner, wrap it for the grantee under _their_ KEK, insert the grant row. Nothing is re-encrypted; the one data key gains one more holder. Unsharing deletes the access grant and the grantee's wrapping (`revokeChatKey`). Deleting the chat deletes its key, and every wrapping cascades.

The access grant is the decision; the wrapping follows it. If a share's rewrap did not land (a crash between the two writes, or a grant that predates the key store), the grantee's first read heals it: `chatCipherFor` sees a valid access grant with no wrapping and performs the share then.

## Who opens with what

`resolveChatAccess` now returns a `cipher` with the access; every read and write of a chat's rows takes one (there is no default on the message layer, so a row cannot be written under the wrong key by omission). `apps/web/lib/chat/chat-keys.ts` decides:

| Reader                                                                       | Opens as                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| The owner                                                                    | Themselves; a chat with no key yet gets one on this access |
| A named viewer (`resource_access_grants`)                                    | Themselves, through the share's wrapping; healed if absent |
| A project member reading a fellow member's chat                              | The chat's owner                                           |
| A process with nobody signed in: a resumed turn, a worker's note, the sweeps | The chat's owner                                           |
| Search across the sidebar (`chatCiphersFor`)                                 | The viewer where they hold the key, else the owner         |

"As the owner" is possible because every process holding the master can derive any KEK. That is the honest statement of what this design is: **key separation** — per-person keys, per-chat keys, a cryptographic sharing model, rotation and a shred for one person — and not end-to-end encryption. It is also what lets a turn resume after the process that started it is gone, and what lets a worker drop a note into a chat while its owner is away.

## Connector credentials

A value that belongs to exactly one person and is never shared needs no DEK: it is sealed directly under their KEK as `uenc1:<secretbox>` (`sealForSubject` / `openForSubject` in `@renkei/user-keys`). Four stores do this now:

- `provider_grants` — access and refresh tokens, whenever the grant has a `subject` (`packages/provider-grants/src/store.ts`; the refresh path re-seals, so a refresh is also how an old row moves over). A grant with no subject stays under the deployment key.
- `mirth_instance_connections`, `admanager_instance_connections`, `file_share_connections` — the person's own credential for an instance or share (`user-credentials.ts` in each connector package; the connection routes seal, the workers open).

Readers accept both forms: `uenc1:` under the owner's KEK, anything else under the deployment key the worker still holds. So nothing waits on a cutover.

## Rollout

Readers accept `renc1` and `renc2` alike on chat rows, and deployment-key and `uenc1:` alike on credentials, so the deploy is safe on its own: new chats are keyed from the first write, old chats are readable, and a legacy chat's owner mints its key on their first access (wrapped for everyone the chat was already shared with). To move everything that is left:

```
cd packages/user-keys
DATABASE_URL=… pnpm rekey-chats          # every chat: a key, and its rows under it
DATABASE_URL=… pnpm rekey-chats --all    # …plus provider_grants and the three credential tables
```

Batched and resumable; a row already under its target key is skipped. `chat_summaries.content` predates both envelopes and may be plaintext — the sweep seals those too, and the reader (`openStoredText`) accepts the plaintext until it does.

The orphan prune in `apps/worker-agents/src/chat-sweep.ts` removes a key whose chat is gone, the same way it removes an orphaned access grant.

## What is not keyed yet

- **Chat attachments' extracted text** (`chat_attachments.extracted_text`), **project instructions and memories**, and **a person's own chat memory** stay under the `renc1` deployment envelope: an attachment can belong to a project rather than a chat and can be copied between chats, and memories are per project or per person rather than per chat, so each wants a key of its own kind. The ciphers are in place (`legacyCipher` marks every such call site); giving those tables keys is a follow-up.
- **Projects** have no key hierarchy: a project member reads a fellow member's chat as its owner. The natural next step is a project DEK wrapped for its members, with each member chat's DEK wrapped under the project DEK, which is why `resource_keys.resource_kind` already admits `chat_project` and `prompt_library`.
- **Rotation and shred have no UI or route.** `rotateUserKek` and `shredUserKek` are callable; what triggers them (an offboarding, an admin action) is a product decision.
- **Credentials sealed under a KEK are not rewrapped by `rotateUserKek`**, which only rewraps `resource_key_grants`. A rotation that must also move `uenc1:` rows re-seals them with `sealForSubject` under the new KEK; the sweep's connector pass is the shape of that code.

## Files

| Where                                                                     | What                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/crypto/src/keys.ts`                                             | HKDF KEK derivation, wrap/unwrap, the `renc2` and `uenc1` envelopes, the master resolver |
| `packages/db/src/migrations/133-user-encryption-keys`                     | `user_encryption_keys`, `resource_keys`, `resource_key_grants`                           |
| `packages/user-keys/src/kek.ts`                                           | `getUserKek`, `ensureUserKek`, `rotateUserKek`, `shredUserKek`                           |
| `packages/user-keys/src/resource-keys.ts`                                 | create / open / share / revoke / delete a resource's key; batch open; the orphan prune   |
| `packages/user-keys/src/user-sealed.ts`                                   | `sealForSubject` / `openForSubject` for person-only values                               |
| `packages/user-keys/scripts/rekey-chats.ts`                               | The rollout sweep                                                                        |
| `apps/web/lib/chat/content-crypto.ts`                                     | `ContentCipher`, `legacyCipher`, `resourceCipher`                                        |
| `apps/web/lib/chat/chat-keys.ts`                                          | The chat's use of the key store: who opens as whom, share, revoke, delete                |
| `apps/web/lib/chat/access.ts`                                             | `ChatAccess.cipher`                                                                      |
| `apps/worker/src/handlers/chat-note.ts`                                   | A worker writing into a chat under its key                                               |
| `packages/provider-grants/src/store.ts`                                   | Tokens under the owner's key                                                             |
| `packages/connector-{mirth,admanager,fileshares}/src/user-credentials.ts` | Credentials under the owner's key                                                        |
