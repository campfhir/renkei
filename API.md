# API Documentation

This document describes the MCP Gateway and Admin API endpoints.

## Authentication

Most endpoints require an operator session (HTTP-only cookie). OAuth/OIDC authentication is required to create a session.

### Session Management

**Sign In**
- `GET /admin/[slug]/sign-in` - Initiates OIDC authorization flow
  - Generates state + nonce
  - Stores pending state in database (15-min TTL)
  - Redirects to OIDC provider

**OAuth Callback**
- `GET /api/oauth/callback` - Receives authorization code from OIDC provider
  - Verifies state (CSRF protection)
  - Exchanges code for tokens
  - Verifies ID token signature using JWKS
  - Creates operator session (4-hour expiration)
  - Persists session to database
  - Sets HTTP-only session cookie
  - Redirects to admin dashboard

**Sign Out**
- `POST /api/auth/sign-out` - Clears operator session
  - Removes session cookie
  - Response: `{ success: true }`

## MCP Gateway

The MCP gateway proxies JSON-RPC 2.0 requests to Jira Cloud API.

### Request Format

```
POST /api/mcp/[siteId]
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "methodName",
  "params": { /* method-specific parameters */ },
  "id": 1
}
```

### Supported Methods

#### searchIssues
Search for Jira issues using JQL.

```json
{
  "method": "searchIssues",
  "params": {
    "jql": "project = TEST",
    "maxResults": 50,
    "startAt": 0,
    "fields": ["key", "summary", "status"]
  }
}
```

Maps to: `GET /rest/api/3/issues/search?jql=...`

#### getIssue
Get a specific Jira issue.

```json
{
  "method": "getIssue",
  "params": {
    "issueId": "PROJ-123",
    "fields": ["key", "summary", "description"]
  }
}
```

Maps to: `GET /rest/api/3/issues/{issueId}`

#### createIssue
Create a new Jira issue.

```json
{
  "method": "createIssue",
  "params": {
    "fields": {
      "project": { "key": "PROJ" },
      "summary": "Issue summary",
      "description": "Issue description",
      "issuetype": { "name": "Bug" }
    }
  }
}
```

Maps to: `POST /rest/api/3/issues`

#### updateIssue
Update an existing Jira issue.

```json
{
  "method": "updateIssue",
  "params": {
    "issueId": "PROJ-123",
    "fields": {
      "summary": "Updated summary",
      "status": { "id": "10001" }
    }
  }
}
```

Maps to: `PUT /rest/api/3/issues/{issueId}`

#### deleteIssue
Delete a Jira issue.

```json
{
  "method": "deleteIssue",
  "params": {
    "issueId": "PROJ-123"
  }
}
```

Maps to: `DELETE /rest/api/3/issues/{issueId}`

#### getProject
Get Jira project details.

```json
{
  "method": "getProject",
  "params": {
    "projectKey": "PROJ"
  }
}
```

Maps to: `GET /rest/api/3/projects/{projectKey}`

### Error Responses

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": {
      "detail": "Error description",
      "status": 400
    }
  },
  "id": 1
}
```

**Error Codes:**
- `-32600` - Invalid Request
- `-32601` - Method not found
- `-32602` - Invalid params
- `-32603` - Internal error

### Token Refresh

When a grant token expires, the gateway automatically:
1. Detects 401 response from Jira
2. Fetches new token using refresh_token
3. Updates encrypted grant in database
4. Retries request with new token

## Admin API

### Sites Management

**List Connected Sites**
- `GET /api/admin/[slug]/sites/page.tsx` - Renders page showing connected Jira sites

**Enable/Disable Site**
- `POST /api/admin/[slug]/sites/enabled`
  - Request: `{ site_id: string, enabled: boolean }`
  - Response: `{ success: true, site_id, enabled }`

**Claim New Site**
- `POST /api/admin/[slug]/sites/claim`
  - Request: `{ cloud_id: string, jira_url: string }`
  - Response: `{ success: true, site_id, cloud_id }`

### People Management

**List Users**
- `GET /api/admin/[slug]/people/page.tsx` - Renders page showing connected users

**Revoke User Access**
- `POST /api/admin/[slug]/people/revoke`
  - Request: `{ account_id: string, scope: 'session' | 'credential' }`
  - Response: `{ success: true, account_id, scope }`

### Grant Management

**List Connected Atlassian Grants**
- `GET /api/admin/[slug]/grants`
  - Response: `{ grants: [...], total: number }`
  - Returns: grant_id, cloud_id, account_id, account_display_name, expires_at, isExpired

**Revoke Specific Grant**
- `POST /api/admin/[slug]/grants/[grantId]/revoke`
  - Response: `{ success: true, grant_id, account, message }`

### Logs

**Search Logs**
- `GET /api/admin/[slug]/logs?q=level:error`
  - Query parameter `q`: bored-logs query syntax
  - Response: `{ logs: [...], total: number, hasMore: boolean }`

**Log Query Syntax**

Supported filters:
- `level:error` - Filter by log level (error, warn, info, debug)
- `level:warn`
- `timestamp:>2024-01-01` - Filter by timestamp (supports >, <, >=, <=, =)
- `timestamp:<2024-12-31`
- `message:search term` - Search in message text (case-insensitive)

Examples:
```
?q=level:error
?q=level:error timestamp:>2024-01-01
?q=message:database
?q=level:warn timestamp:>=2024-07-31
```

**Real-Time Log Stream**
- `GET /api/admin/[slug]/logs/stream?q=level:error`
  - WebSocket endpoint (upgrade required)
  - Supports same query syntax as search logs
  - Returns: streaming JSON log objects

### Audit

**View Audit Log**
- `GET /api/admin/[slug]/audit/page.tsx` - Renders audit log page
  - Shows: event_type, actor_id, resource_id, created_at

### Settings

**View Settings**
- `GET /api/admin/[slug]/settings/page.tsx` - Renders settings page
  - Shows: organization slug, OIDC configuration status

## Security

### Encryption

All Atlassian access tokens are encrypted at rest using AES-256-GCM:
- Algorithm: AES-256-GCM
- Key: 32-byte base64-encoded from TOKEN_ENCRYPTION_KEY env var
- Nonce: 12 random bytes per encryption
- Format: base64(nonce || ciphertext || tag)

### CSRF Protection

OAuth flow includes state verification:
1. State generated on sign-in page (UUID)
2. Stored in pending_oidc_signin table with 15-min TTL
3. Verified on callback route
4. Deleted after use (prevents replay attacks)

### Session Security

- HTTP-only cookies (JavaScript cannot access)
- 4-hour expiration
- 15-minute idle timeout
- Session persisted to database for recovery

### Token Validation

- ID tokens verified with JWKS from OIDC provider
- Issuer, audience, expiration validated
- 30-second clock tolerance for clock skew

## Examples

### Search Jira Issues

```bash
curl -X POST http://localhost:3000/api/mcp/site-id \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "searchIssues",
    "params": {
      "jql": "project = PROJ AND status = \"Open\"",
      "maxResults": 10
    },
    "id": 1
  }'
```

### List Connected Grants

```bash
curl http://localhost:3000/api/admin/test-slug/grants \
  -H "Cookie: renkei_operator=<session-token>"
```

### Revoke a Grant

```bash
curl -X POST http://localhost:3000/api/admin/test-slug/grants/grant-123/revoke \
  -H "Cookie: renkei_operator=<session-token>"
```

### Search Error Logs from Today

```bash
curl http://localhost:3000/api/admin/test-slug/logs?q=level:error+timestamp:>2024-07-31 \
  -H "Cookie: renkei_operator=<session-token>"
```

## Rate Limiting

Currently no rate limiting implemented. Recommended for production:
- MCP gateway: 100 requests/minute per grant
- Admin API: 1000 requests/minute per operator
- OAuth: 10 sign-in attempts/minute per IP

## WebSocket Events (Real-Time Logs)

Stream endpoint supports these event types:

```json
{
  "type": "log",
  "log": {
    "log_id": "uuid",
    "message": "Error message",
    "level": "error",
    "logged_timestamp": "2024-07-31T12:34:56Z",
    "attributes": {}
  }
}
```

Event types:
- `log` - New log entry
- `filter_updated` - Filter changed
- `connection_closed` - Stream closing

## Common Response Codes

- `200` - Success
- `400` - Bad request (missing params, invalid query)
- `401` - Unauthorized (no valid session or expired token)
- `404` - Not found (tenant, grant, or resource)
- `500` - Internal server error

## Environment Variables

Required for API functionality:
- `ATLASSIAN_CLIENT_ID` - OAuth app client ID
- `ATLASSIAN_CLIENT_SECRET` - OAuth app client secret
- `ATLASSIAN_REDIRECT_URI` - OAuth redirect URL
- `TOKEN_ENCRYPTION_KEY` - 32-byte base64-encoded encryption key
- `DATABASE_URL` - PostgreSQL connection string
- `PUBLIC_BASE_URL` - Public URL of this server
