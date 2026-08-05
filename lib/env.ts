import { z } from 'zod';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const envSchema = z.object({
  // Atlassian OAuth
  ATLASSIAN_CLIENT_ID: z.string(),
  ATLASSIAN_CLIENT_SECRET: z.string(),
  ATLASSIAN_REDIRECT_URI: z.string().url(),
  ATLASSIAN_SCOPES: z.string(),

  // Optional for HTTP gateway (not stdio)
  ATLASSIAN_CLOUD_ID: z.string().optional(),

  // Encryption
  TOKEN_ENCRYPTION_KEY: z.string().refine(
    (key) => {
      const decoded = Buffer.from(key, 'base64');
      return decoded.byteLength === 32;
    },
    {
      message: 'TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
    }
  ).transform((key) => Buffer.from(key, 'base64')),

  // Database
  DATABASE_URL: z.string().url(),
  PLATFORM_DATABASE_URL: z.string().url().optional(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),

  // Server
  PUBLIC_BASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(3000),

  // Limits
  MAX_JQL_RESULTS: z.coerce.number().default(100),
  RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().default(60),
  MAX_ATTACHMENT_BYTES: z.coerce.number().default(20_971_520), // 20MB

  // Optional
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PLATFORM_OIDC: z.string().optional(),
  ENABLE_DCR: z.enum(['true', 'false']).default('false'),
  READ_ONLY: z.enum(['true', 'false']).default('false'),
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Result<Env, 'CONFIG_ERROR'> {
  const env = {
    ATLASSIAN_CLIENT_ID: process.env.ATLASSIAN_CLIENT_ID,
    ATLASSIAN_CLIENT_SECRET: process.env.ATLASSIAN_CLIENT_SECRET,
    ATLASSIAN_REDIRECT_URI: process.env.ATLASSIAN_REDIRECT_URI,
    ATLASSIAN_SCOPES: process.env.ATLASSIAN_SCOPES,
    ATLASSIAN_CLOUD_ID: process.env.ATLASSIAN_CLOUD_ID,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    PLATFORM_DATABASE_URL: process.env.PLATFORM_DATABASE_URL,
    MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    HOST: process.env.HOST,
    PORT: process.env.PORT,
    MAX_JQL_RESULTS: process.env.MAX_JQL_RESULTS,
    RATE_LIMIT_PER_USER_PER_MINUTE: process.env.RATE_LIMIT_PER_USER_PER_MINUTE,
    MAX_ATTACHMENT_BYTES: process.env.MAX_ATTACHMENT_BYTES,
    LOG_LEVEL: process.env.LOG_LEVEL,
    PLATFORM_OIDC: process.env.PLATFORM_OIDC,
    ENABLE_DCR: process.env.ENABLE_DCR,
    READ_ONLY: process.env.READ_ONLY,
  };

  const result = envSchema.safeParse(env);
  if (!result.success) {
    return err('CONFIG_ERROR' as const);
  }

  return ok(result.data);
}

let config: Env | null = null;

export function getConfig(): Result<Env, 'CONFIG_ERROR'> {
  if (!config) {
    const result = loadConfig();
    if (!result.ok) {
      return result;
    }
    config = result.val;
  }
  return ok(config);
}
