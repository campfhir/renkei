/**
 * Integration test against Atlassian API
 * Tests OAuth token endpoint and Jira API endpoints
 * Requires: ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET in env
 */

import { config } from 'dotenv';

// Load .env.development
config({ path: '.env.development' });

describe('Atlassian API integration', () => {
  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;

  beforeAll(() => {
    if (!clientId || !clientSecret) {
      throw new Error('ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET must be set');
    }
  });

  it('should have valid OAuth credentials configured', () => {
    expect(clientId).toBeDefined();
    expect(clientSecret).toBeDefined();
    expect(clientId).toMatch(/^[A-Za-z0-9]+$/);
    expect(clientSecret).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('should reject refresh token endpoint with invalid refresh token', async () => {
    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: 'invalid_refresh_token_123',
      }),
    });

    expect([401, 403]).toContain(response.status);
    const data = await response.json();
    console.log(`Token endpoint error: ${data.error}`);
    // Could be access_denied (invalid token) or unauthorized_client (bad credentials)
    expect(['access_denied', 'unauthorized_client']).toContain(data.error);
    if (data.error === 'unauthorized_client') {
      console.warn('⚠️  OAuth client credentials may be invalid or app is disabled');
    }
  });

  it('should reject Jira myself endpoint without auth', async () => {
    // Try to access myself without any token
    const response = await fetch(
      'https://north-east-medical-services.atlassian.net/rest/api/3/myself',
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    expect(response.status).toBe(401);
    console.log('✓ Jira myself endpoint rejects unauthenticated request');
  });

  it('should reject Jira myself endpoint with invalid token', async () => {
    const response = await fetch(
      'https://north-east-medical-services.atlassian.net/rest/api/3/myself',
      {
        headers: {
          Authorization: 'Bearer invalid_token_xyz_123',
          Accept: 'application/json',
        },
      }
    );

    expect([401, 403]).toContain(response.status);
    console.log('✓ Jira myself endpoint rejects invalid token');
  });

  it('should accept valid request to accessible-resources endpoint (but fails without token)', async () => {
    const response = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: {
        Authorization: 'Bearer invalid_token',
        Accept: 'application/json',
      },
    });

    // Should get 401, not 500 or other error
    expect(response.status).toBe(401);
    console.log('✓ Accessible-resources endpoint is reachable');
  });

  it('should verify Jira site URL is configured correctly', async () => {
    const cloudId = process.env.ATLASSIAN_CLOUD_ID;
    expect(cloudId).toBeDefined();

    // Without token, we should still get a 401, not 404 (which would mean the site doesn't exist)
    const response = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
      headers: {
        Authorization: 'Bearer invalid_token',
        Accept: 'application/json',
      },
    });

    // 401 means the site exists but token is invalid (good)
    // 404 would mean the site or path doesn't exist (bad)
    expect([401, 403]).toContain(response.status);
    console.log(`✓ Jira site accessible via API gateway (status: ${response.status})`);
  });

  it('should log OAuth client configuration', () => {
    console.log('\n📋 OAuth Configuration:');
    console.log(`  Client ID: ${clientId?.substring(0, 10)}...`);
    console.log(`  Client Secret: ${clientSecret?.substring(0, 10)}...`);
    console.log(`  Cloud ID: ${process.env.ATLASSIAN_CLOUD_ID}`);
    console.log(`  Jira Site: ${process.env.ATLASSIAN_REDIRECT_URI}`);
  });
});
