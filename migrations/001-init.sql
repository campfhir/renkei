-- Initial schema for Renkei

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  slug VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_oidc (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  issuer VARCHAR(255) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  client_secret VARCHAR(255) NOT NULL,
  authorization_endpoint VARCHAR(255) NOT NULL,
  token_endpoint VARCHAR(255) NOT NULL,
  jwks_uri VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_jira_sites (
  site_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cloud_id VARCHAR(255) NOT NULL,
  jira_url VARCHAR(255) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  claimed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS atlassian_grants (
  grant_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cloud_id VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  account_display_name VARCHAR(255),
  encrypted_token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  session_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  subject VARCHAR(255) NOT NULL,
  operator_name VARCHAR(255) NOT NULL,
  issued_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_oidc_signin (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  state VARCHAR(255) NOT NULL UNIQUE,
  nonce VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  log_id UUID PRIMARY KEY,
  tenant_id UUID,
  message TEXT NOT NULL,
  level VARCHAR(50),
  logged_timestamp TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS log_attributes (
  id UUID PRIMARY KEY,
  log_id UUID NOT NULL REFERENCES logs(log_id),
  key VARCHAR(255) NOT NULL,
  value VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id UUID PRIMARY KEY,
  event_type VARCHAR(255) NOT NULL,
  actor_id VARCHAR(255),
  resource_id VARCHAR(255),
  details JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tenant_jira_sites_cloud_id ON tenant_jira_sites(cloud_id);
CREATE INDEX IF NOT EXISTS idx_grants_cloud_id ON atlassian_grants(cloud_id);
CREATE INDEX IF NOT EXISTS idx_grants_expires_at ON atlassian_grants(expires_at);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_expires_at ON operator_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_signin_state ON pending_oidc_signin(state);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(logged_timestamp);
