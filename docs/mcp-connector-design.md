# Remote MCP servers as connectors — design

Written alongside the change that built it. An admin lists remote MCP servers; each person signs in **at the server**, and what they can do is whatever the server lists for them. Renkei adds no authorization of its own and removes none.

## What the admin does

`/admin/mcp` (operators) keeps the list. A server is:

| Field                          | Meaning                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name, **tool prefix** (`slug`) | What people and the model call it. Tools are named `<slug>__<tool>`; the capability key is `mcp-<slug>`. The prefix is fixed at creation — chats remember tools by it and switches name it. |
| URL, **transport**             | `https` (loopback `http` for a server beside Renkei in development). Streamable HTTP, or the legacy HTTP+SSE transport.                                                                     |
| **sign-in**                    | `oauth` (the server's own authorization server signs people in) or `none` (an open server).                                                                                                 |
| **context**                    | Free text, up to 4000 characters: what the server is for, the systems and vocabulary it covers. Searched by `find_tools` and shown to the model beside the matched tools.                   |
| client ID / secret, scopes     | Optional. Renkei registers itself automatically (below); fill these in only for a server that issued a client by hand. The secret is write-only and sealed with `TOKEN_ENCRYPTION_KEY`.     |
| enabled                        | The org-wide off switch for this server.                                                                                                                                                    |

**Check** runs discovery now (and registration where the server allows it) through the delegate and says what it found — a wrong URL, an authorization server Renkei cannot register with, or a server that turns out to need no sign-in. Saving a different server origin, sign-in mode or client **ends everyone's connection** to it (a token issued by one server must never reach another); the form says so first.

## How a person connects

`/connectors` has an "MCP servers" card: one row per enabled server in the person's audience. **Connect** is the MCP authorization flow:

1. `GET /api/mcp-servers/<id>/authorize` asks the delegate to `mcp/prepare` the server.
2. The delegate discovers the authorization server (the 401 challenge's `resource_metadata`, else the well-known documents; RFC 9728 / RFC 8414) and saves the endpoints on the row. With no client yet and a registration endpoint on offer it registers Renkei (RFC 7591) — as a public PKCE client when the server allows it, else with a secret it seals on the row. With no registration endpoint it answers `NEEDS_CLIENT` and the admin must enter a client ID.
3. The browser is redirected to the server's authorization endpoint (Authorization Code + PKCE S256, with the RFC 8707 `resource` indicator naming the MCP server). The state, verifier and subject sit on a `pending_oidc_signin` row, bound to the browser by the usual connect cookie.
4. The shared `/api/oauth/callback` recognises `mcp:<id>`, has the delegate exchange the code (`oauth/exchange`) and seal the tokens (`grant/commit`), lists the server's tools once, and returns the person to `/connectors`.

The grant is an ordinary `provider_grants` row under provider **`mcp:<server id>`**, keyed by the person (the flow carries no identity claim), so everything that is true of other grants is true here: sealed under the person's own key, held, refreshed and dialed only by the delegate, deleted on disconnect (which also revokes at the server where it offers revocation) and when the admin deletes the server.

An open server has no Connect step: the card lists its tools the first time it is seen.

## Where the delegate comes in

Providers are a fixed table in `apps/worker-delegate/src/providers.ts`; an MCP server is data. `resolveProviderSpec` adds the dynamic case: `mcp:<id>` is built from that server's row — its **origin is the only place its token may go** (redirects re-checked, as for every provider), the token endpoint and client come from discovery, and `GenericOAuthAdapter` (`packages/provider-grants`) refreshes. A disabled or deleted server has no spec, so nothing of it is dialed. An open server's spec is `anonymous`: the proxy attaches no credential.

Two limits are deliberate:

- The authorization server may be a different origin from the MCP server, and the MCP server names it — a remote party. Its endpoints must therefore be public https addresses (`assertPublicHttpsUrl`) unless they share the MCP server's own origin, which the admin registered and may be on a private network.
- Discovery and registration run in the delegate, not the web app, so the process that holds client secrets is the one that dials MCP servers, and a private-network server works.

`mcp/prepare` is web-only (`WEB_ONLY_OPS`).

## Tools: listed live, found by name

What a server lists can differ per person, and registering tools performs no I/O (`registry.ts`), so each person's `tools/list` is cached in `mcp_user_tool_lists` and kept current two ways. Nothing awaits a network call on the tools request path.

- **Push, where the server supports it.** If the server advertises `tools.listChanged` at initialize, Renkei holds its notification stream (a GET on the Streamable HTTP endpoint, or the legacy SSE stream itself) and refreshes the list the moment `notifications/tools/list_changed` arrives (`lib/mcp-servers/watch.ts`, `watchToolListChanges` in the client). A watch is one long-lived request through the delegate per person and server in the web process, so it lasts only while wanted: started when the person connects or their tool surface is resolved, dropped after 30 idle minutes, on a sign-in failure, on disconnect, or when the server is disabled, moved or deleted, and reconnected with backoff when the stream drops. Each replica watches for itself; refreshing is idempotent.
- **Timer and on demand, otherwise.** A server that does not advertise the capability (or offers no stream) is not watched, and is not asked again for an hour. The fallback is the whole mechanism for it: refresh when the person connects, on **Refresh tools**, in the background when a cached list is over 15 minutes old, and after a call fails (a tool the server no longer lists is the usual cause).

Each cached tool is registered as `<slug>__<tool>` under the capability key `mcp-<slug>` (`lib/mcp-tools/mcp-servers`):

- the server's own JSON Schema is advertised as given and the **server validates the call** — Renkei does not compile schemas it did not write;
- a tool is an **act** unless the server marked `readOnlyHint: true` (the conservative reading every connector gets), so an org in read-only mode loses the rest, and chat asks permission before running one. Remote acts have no bespoke preview card (`previews/` draws cards for known tools), so they go through the permission ask;
- the call goes through the delegate as that person; a 401 reads "reconnect on the Connectors page".

Because `mcp-<slug>` is a capability key, the existing gates apply per server: the org's `disabledConnectors`, an audience (`connectorAudiences`), the person's hidden capabilities, read-only mode.

**In chat**, a connected server's tools are always _discoverable_ and never offered up front: `isMcpServerConnector` puts them among a chat's candidates whatever its toolset says (the person chose to connect the server; there is no per-chat switch for it). `find_tools` searches a server's name and its admin context as well as the tools' own words, so asking for "insurance claims" finds the server the admin described that way, and the result says what the server is for once per server. Matches become callable from the next reply and are recalled on later turns like any other discovery.

## Tables

`mcp_servers` (the registry; `slug` unique) and `mcp_user_tool_lists` (per person and server). Migration 159 also widens `pending_oidc_signin.provider` to 64 characters (`mcp:` + a uuid is 40). Both tables feed the tool-surface version, so a changed server or refreshed list retires cached handlers on every replica.

## Not done / follow-ups

- No per-server audience screen: `connectorAudiences` already accepts `mcp-<slug>` keys and the connectors page honours them, but the audience editor lists only catalog entries.
- Only tools are supported for now. A server's resources and prompts (and their own list-changed notices) are not surfaced; the client and watch are shaped so they can be added.
- Acts have no preview card. Cards are drawn per known tool; a generic card that merely prints arguments is exactly what `act-preview.ts` rules out.
- A registration is made for one redirect URI. If the deployment's public address changes, clear the client ID in the form (Remove the stored secret) and Check again to register afresh.
