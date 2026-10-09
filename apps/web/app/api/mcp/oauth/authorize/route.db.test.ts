/**
 * The authorization endpoint's consent step against a real database
 * (skipped without DATABASE_URL): a request without S256 PKCE is turned
 * away on the client's own redirect URI; a valid one from a signed-in
 * browser lands on the consent page instead of minting a code; only the
 * session that was shown the page may answer, only from this origin, and
 * only once; Deny sends `access_denied`; Allow mints a code the token
 * endpoint exchanges for exactly the verifier the challenge committed to,
 * and for nothing else.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { NextRequest } from 'next/server';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { hashToken } from '@/lib/mcp-token';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { computeS256 } from '@/lib/oauth-pkce';
import { getOrigin } from '@/lib/get-origin';
import { GET, POST } from './route';
import { POST as token } from '../token/route';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
