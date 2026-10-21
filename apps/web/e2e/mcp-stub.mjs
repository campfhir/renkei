/**
 * A stand-in remote MCP server for the e2e suite (port 8093): everything a
 * real one gives Renkei to talk to, in one file with no dependencies.
 *
 *   /mcp         Streamable HTTP, bearer-protected (401 + a resource_metadata
 *                challenge when the token is missing or unknown)
 *   /sse         the legacy HTTP+SSE transport (GET stream + POST /messages)
 *   /open/mcp    Streamable HTTP with no authorization at all
 *   OAuth        protected-resource and authorization-server metadata,
 *                dynamic client registration (public clients), an authorize
 *                endpoint that approves at once and redirects with a code,
 *                and a token endpoint (authorization_code with PKCE, and
 *                refresh_token)
 *
 * Tools: `lookup_policy` (readOnlyHint) and `file_claim` (an act). Calls echo
 * which bearer made them, so a spec can tell whose token arrived.
 *
 * `GET /__state` reports what the stub saw (registrations, tokens issued,
 * calls) for assertions; `POST /__reset` clears it.
 */

/* global Buffer, URL, URLSearchParams, console */

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 8093;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const clients = new Map();
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const sseSessions = new Map();
const state = { registrations: 0, tokensIssued: 0, refreshes: 0, calls: [] };

const BASE_TOOLS = [
  {
    name: 'lookup_policy',
    description: 'Look up an insurance policy by number.',
    inputSchema: {
      type: 'object',
      properties: { policyNumber: { type: 'string', description: 'The policy number' } },
      required: ['policyNumber'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'file_claim',
    description: 'File a new claim against a policy.',
    inputSchema: {
      type: 'object',
      properties: { policyNumber: { type: 'string' }, summary: { type: 'string' } },
      required: ['policyNumber'],
    },
  },
];

const CHANGED_TOOL = {
  name: 'search_claims',
  description: 'Search claims by free text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
let TOOLS = [...BASE_TOOLS];
/** Open Streamable HTTP GET streams, to push notifications to. */
const listeners = new Set();

function announceToolChange() {
  const frame = `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  })}\n\n`;
  for (const res of listeners) res.write(frame);
  for (const session of sseSessions.values()) session.res.write(frame);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function challenge(res) {
  res.writeHead(401, {
    'www-authenticate': `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    'content-type': 'application/json',
  });
  res.end('{"error":"unauthorized"}');
}

/** The JSON-RPC answer for one request, or null for a notification. */
function rpc(message, who) {
  if (message.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'e2e-mcp-stub', version: '1.0.0' },
      });
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = message.params ?? {};
      state.calls.push({ name, args, who });
      return reply({
        content: [{ type: 'text', text: `${name} ran for ${who}: ${JSON.stringify(args)}` }],
        isError: false,
      });
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);

  if (url.pathname === '/health') return json(res, 200, { ok: true });
  if (url.pathname === '/__state') return json(res, 200, state);
  if (url.pathname === '/__reset') {
    state.registrations = 0;
    state.tokensIssued = 0;
    state.refreshes = 0;
    state.calls = [];
    TOOLS = [...BASE_TOOLS];
    return json(res, 200, { ok: true });
  }
  // A spec changes what the server offers; connected clients are told.
  if (url.pathname === '/__tools' && req.method === 'POST') {
    TOOLS = [...BASE_TOOLS, CHANGED_TOOL];
    announceToolChange();
    return json(res, 200, { tools: TOOLS.length });
  }

  // ── discovery ──────────────────────────────────────────────────────────
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return json(res, 200, { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  }
  if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
    return json(res, 200, {
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
    });
  }

  // ── OAuth ──────────────────────────────────────────────────────────────
  if (url.pathname === '/register' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const clientId = `stub-client-${randomUUID()}`;
    clients.set(clientId, body.redirect_uris ?? []);
    state.registrations += 1;
    return json(res, 201, { client_id: clientId, redirect_uris: body.redirect_uris });
  }
  if (url.pathname === '/authorize') {
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    const clientId = url.searchParams.get('client_id') ?? '';
    if (!clients.has(clientId) || !clients.get(clientId).includes(redirect)) {
      return json(res, 400, { error: 'invalid_client' });
    }
    // The resource indicator names the endpoint the person connected: /mcp or /sse.
    if (![`${ORIGIN}/mcp`, `${ORIGIN}/sse`].includes(url.searchParams.get('resource') ?? '')) {
      return json(res, 400, { error: 'invalid_target' });
    }
    const code = randomUUID();
    codes.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      redirect,
      clientId,
    });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const grant = form.get('grant_type');
    let who;
    if (grant === 'authorization_code') {
      const record = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (
        !record ||
        record.challenge !== expected ||
        record.redirect !== form.get('redirect_uri')
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      who = record.clientId;
    } else if (grant === 'refresh_token') {
      who = refreshTokens.get(form.get('refresh_token') ?? '');
      if (!who) return json(res, 400, { error: 'invalid_grant' });
      state.refreshes += 1;
    } else {
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const access = `at-${randomUUID()}`;
    const refresh = `rt-${randomUUID()}`;
    accessTokens.set(access, who);
    refreshTokens.set(refresh, who);
    state.tokensIssued += 1;
    return json(res, 200, {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp',
    });
  }

  // ── Streamable HTTP ────────────────────────────────────────────────────
  if (url.pathname === '/mcp' || url.pathname === '/open/mcp') {
    let who = 'anonymous';
    if (url.pathname === '/mcp') {
      who = accessTokens.get(bearer(req));
      if (!who) return challenge(res);
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    // The server-to-client stream, for notifications.
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': open\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const message = JSON.parse((await readBody(req)) || '{}');
    const answer = rpc(message, who);
    if (!answer) {
      res.writeHead(202);
      return res.end();
    }
    // Initialize answers as an event stream, everything else as JSON, so
    // both response shapes get exercised.
    if (message.method === 'initialize') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'mcp-session-id': 'stub-session',
      });
      return res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    }
    return json(res, 200, answer, { 'mcp-session-id': 'stub-session' });
  }

  // ── legacy HTTP + SSE ──────────────────────────────────────────────────
  if (url.pathname === '/sse' && req.method === 'GET') {
    const who = accessTokens.get(bearer(req));
    if (!who) return challenge(res);
    const sid = randomUUID();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`event: endpoint\ndata: /messages?sid=${sid}\n\n`);
    sseSessions.set(sid, { res, who });
    req.on('close', () => sseSessions.delete(sid));
    return;
  }
  if (url.pathname === '/messages' && req.method === 'POST') {
    const session = sseSessions.get(url.searchParams.get('sid') ?? '');
    if (!session || accessTokens.get(bearer(req)) !== session.who) return challenge(res);
    const message = JSON.parse((await readBody(req)) || '{}');
    const answer = rpc(message, session.who);
    if (answer) session.res.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    res.writeHead(202);
    return res.end('Accepted');
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mcp-stub listening on ${ORIGIN}`);
});
