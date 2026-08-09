#!/usr/bin/env node
/**
 * Generate every secret the e2e log-shipping pipeline needs and print them as
 * ready-to-paste .env lines:
 *
 *   pnpm --filter renkei generate:log-ship-keys
 *
 * Both compose services read the same .env, so the whole block goes in one
 * place. Uses the bored-logs generators (not hand-rolled JWKs) so the key
 * shapes always match what the library imports.
 */
import { randomBytes } from 'node:crypto';
import { generateE2EServerKeys } from '@campfhir/bored-logs/server';
import { generateE2ESigningKeys } from '@campfhir/bored-logs/adapters/http';

const apiKey = randomBytes(32).toString('base64url');
const serverKeys = await generateE2EServerKeys();
const signingKeys = await generateE2ESigningKeys();

console.log('# --- e2e log shipping (generated ' + new Date().toISOString() + ') ---');
console.log('# Shared bearer key: the web app accepts it, the worker presents it.');
console.log('# Comma-separate old,new here to rotate without a gap.');
console.log(`LOG_SHIP_API_KEY=${apiKey}`);
console.log('# Web (log server): static ECDH keypair, so shipments stay valid across restarts.');
console.log(`LOG_E2E_SERVER_KEYS=${JSON.stringify(serverKeys)}`);
console.log('# Worker (shipper): switches it from direct-DB logging to encrypted HTTP shipping.');
console.log('# `renkei` is the web service name on the compose network; adjust if yours differs.');
console.log('LOG_SHIP_ENDPOINT=http://renkei:3000/api/logs');
console.log('# Persistent signing identity — one pinned registration across worker restarts.');
console.log(`LOG_SHIP_SIGNING_KEYS=${JSON.stringify(signingKeys)}`);
