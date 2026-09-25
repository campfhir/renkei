# Entra Developer connector — design

A point-in-time design doc (see [`README.md`](./README.md)); the as-built description is the
`entra-developer` section of [`connectors.md`](./connectors.md).

## What it is for

Developers and application owners spend real time in the Entra portal doing the same few things:
registering an application, giving it an enterprise application so it shows up under Enterprise
applications and can have people assigned, defining app roles, fixing redirect URIs, and putting
users and groups into roles. The connector lets them do that from any Renkei surface — the chat,
an MCP client, an agent — with their own Entra rights, and with every change shown on a card
before it reaches the directory.

## Decisions

### A second Entra app registration, not more scopes on the Microsoft 365 one

The Microsoft 365 connector already runs through an Entra app registration, so the tempting shape
was a fourth panel on its card ("Applications", beside Outlook, OneDrive and SharePoint) with a few
more checkboxes. Rejected, for the same reason Jira Administration and OnBase Administration are
their own connectors:

- The permissions are **directory-wide and admin-consented**. `Application.ReadWrite.All` reaches
  every application in the tenant, `AppRoleAssignment.ReadWrite.All` every assignment,
  `Group.Read.All` every group. Nobody should have to be offered those to read their own mail, and
  an org admin should be able to say "developers only" (an audience rule) without touching what
  everyone else's Microsoft 365 grant carries.
- Microsoft issues **one consent per app**, and a re-consent replaces it. Adding directory-wide
  scopes to the Microsoft 365 app would put them on every reconnect of every person.
- A separate app registration is a separate **off switch**: `disabledConnectors` names
  `entra-developer` on its own.

So: connector `entra-developer`, its own `connector_configs` row, grant provider, capability key,
connect flow and card. The one piece shared with Microsoft 365 is the token exchange in the OAuth
callback (`exchangeMicrosoftCode`) and the refresh adapter (`MicrosoftAdapter` gained a provider
parameter, the `AtlassianAdapter` shape). The card is a card of its own rather than a panel inside
the Microsoft 365 card, because that card's whole structure states "one consent covers every
product below" and this is a different consent on a different app.

### Every write is preview + confirm

The ADManager Plus rule, not Mirth's "only permanent operations" one. An app registration is what
the whole organization signs in through; a wrong redirect URI is an open redirect, a role handed
to the wrong group is an authorization bug in production, and Entra keeps no version history to
undo either. The preview resolves every reference (a name to an id, an address to a user) and
shows exactly what will be sent — old value against new for an update; who will be assigned, and
who already is, for an assignment — and the confirm re-resolves and sends it. The card is the
existing `directory_action_preview` widget: its `person` slot shows the application (or the
assignee, with the application as the secondary line), and its group lists carry roles.

### References resolve; ambiguity refuses

Every tool takes an application as an object id, an application (client) id, or an exact display
name; a person or group as an object id, an address, or an exact display name; a role as its id,
claim value or display name. A GUID is tried as an object id first and as an application id on 404. A name that matches more than one object is refused with the ids, never guessed at — this is
provisioning, and the cost of acting on the wrong "Payroll" is real.

### Scope gating at registration, Entra's rules at call time

`entra-developer/scopes.ts` names the delegated scopes each tool's Graph calls need, and
`withScopeGate` registers only what the grant carries — a grant with `Application.Read.All` alone
sees the reads and none of the writes. What the token allows is not what Entra allows: creating
applications may be restricted to admins (`Users can register applications` off), and changing an
application needs ownership of it (or a directory role). Those are checked by Graph on every call
and surfaced with Graph's own reason (`entraRequest` keeps the `error.message`), and
`entra_check_access` says what the connection holds before anything else answers 403.

### Retrieval-only

Nothing is indexed and there is no `verifyAccess`: applications are not knowledge, and every read
is a live Graph call with the caller's own token.

## Graph surface used

| Operation                   | Call                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| List / search registrations | `GET /applications` (`$search` with `ConsistencyLevel: eventual`)               |
| Get a registration          | `GET /applications/{id}`, `GET /applications(appId='…')`                        |
| Create a registration       | `POST /applications`                                                            |
| Change a registration       | `PATCH /applications/{id}` (name, web/spa/publicClient, URIs)                   |
| App roles                   | `PATCH /applications/{id}` with the full `appRoles` list                        |
| Enterprise applications     | `GET /servicePrincipals`, `POST /servicePrincipals { appId }`                   |
| Assignments                 | `GET/POST /servicePrincipals/{id}/appRoleAssignedTo`, `DELETE …/{assignmentId}` |
| People and groups           | `GET /users`, `GET /groups` (`$filter` exact, `$search` partial)                |

App roles are replaced wholesale on PATCH, so an addition sends the existing roles as Graph
returned them plus the new ones (fresh ids, `isEnabled: true`), and a removal sends two PATCHes —
the role disabled, then the list without it — because Entra refuses to drop an enabled role. An
application that defines no roles takes assignments on the default role
`00000000-0000-0000-0000-000000000000`.

## Not in this version

- Client secrets and certificates (`addPassword`): the value is minted by Graph and would have to
  travel back through the model's transcript; left out until there is a safer place to put it.
- API permissions (`requiredResourceAccess`) and exposing scopes (`api.oauth2PermissionScopes`).
- Owners, and deleting or disabling applications.
- Assigning an application (service principal) to a role, as opposed to users and groups.
