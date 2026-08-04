'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function CreateOrganizationContent() {
  const searchParams = useSearchParams();
  const domain = searchParams.get('domain') || '';
  const tenantId = searchParams.get('tenantId') || '';

  const [formData, setFormData] = useState({
    discoveryEndpoint: '',
    clientId: '',
    clientSecret: '',
    roleClaim: 'roles',
    operatorRoleMapping: '',
    userRoleMapping: '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [discoveryValidated, setDiscoveryValidated] = useState(false);
  const [discoveryInfo, setDiscoveryInfo] = useState<{ issuer: string; authEndpoint?: string; tokenEndpoint?: string } | null>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const validateDiscoveryEndpoint = async () => {
    setIsLoading(true);
    setMessage(null);

    try {
      const response = await fetch(formData.discoveryEndpoint);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const discovery = await response.json();

      if (!discovery.issuer) {
        throw new Error('Discovery endpoint missing issuer field');
      }

      setDiscoveryInfo({
        issuer: discovery.issuer,
        authEndpoint: discovery.authorization_endpoint,
        tokenEndpoint: discovery.token_endpoint,
      });
      setDiscoveryValidated(true);
      setMessage({ type: 'success', text: 'Discovery endpoint validated successfully!' });
    } catch (error) {
      setDiscoveryValidated(false);
      setDiscoveryInfo(null);
      setMessage({
        type: 'error',
        text: `Failed to validate discovery endpoint: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!discoveryValidated) {
      setMessage({ type: 'error', text: 'Please validate the discovery endpoint first' });
      return;
    }

    setIsLoading(true);
    setMessage(null);

    try {
      let actualTenantId = tenantId;

      // If no tenant ID, create one for this domain
      if (!actualTenantId && domain) {
        const createResponse = await fetch(`/api/home-realm/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });

        if (!createResponse.ok) {
          const error = await createResponse.json();
          throw new Error(error.error || 'Failed to create tenant');
        }

        const { tenantId: newTenantId } = await createResponse.json();
        actualTenantId = newTenantId;
      }

      if (!actualTenantId) {
        throw new Error('Unable to determine tenant ID');
      }

      const response = await fetch(`/api/tenant/${actualTenantId}/oidc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discoveryEndpoint: formData.discoveryEndpoint,
          clientId: formData.clientId,
          clientSecret: formData.clientSecret,
          roleClaim: formData.roleClaim,
          operatorIdpValue: formData.operatorRoleMapping || undefined,
          userIdpValue: formData.userRoleMapping || undefined,
        }),
      });

      setMessage({ type: 'success', text: 'Organization configured successfully!' });
      setTimeout(() => {
        window.location.href = `/mcp/${actualTenantId}`;
      }, 1500);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'An error occurred',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-black px-4">
      <main style={{ maxWidth: '36rem' }} className="w-full">
        <Link
          href="/"
          className="text-blue-600 hover:text-blue-700 dark:text-blue-400 text-sm mb-6 inline-block"
        >
          ← Back to sign in
        </Link>

        <h1 className="text-3xl font-bold mb-2">Set up your identity provider</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {domain ? `Configure OIDC for ${domain}` : 'Configure your organization identity provider'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              OIDC Discovery Endpoint
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                name="discoveryEndpoint"
                value={formData.discoveryEndpoint}
                onChange={(e) => {
                  handleInputChange(e);
                  setDiscoveryValidated(false);
                  setDiscoveryInfo(null);
                }}
                placeholder="https://auth.example.com/.well-known/openid-configuration"
                required
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={validateDiscoveryEndpoint}
                disabled={isLoading || !formData.discoveryEndpoint}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 disabled:bg-gray-100 dark:bg-gray-700 dark:hover:bg-gray-600 dark:disabled:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium rounded-lg transition-colors"
              >
                {isLoading ? 'Testing...' : 'Test'}
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              The complete .well-known/openid-configuration endpoint URL
            </p>
            {discoveryValidated && discoveryInfo && (
              <div className="mt-3 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <p className="text-sm font-medium text-green-900 dark:text-green-100 mb-2">✓ Discovery validated</p>
                <div className="text-xs text-green-800 dark:text-green-200 space-y-1">
                  <p><strong>Issuer:</strong> {discoveryInfo.issuer}</p>
                  {discoveryInfo.authEndpoint && <p><strong>Auth:</strong> {discoveryInfo.authEndpoint}</p>}
                  {discoveryInfo.tokenEndpoint && <p><strong>Token:</strong> {discoveryInfo.tokenEndpoint}</p>}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Client ID
            </label>
            <input
              type="text"
              name="clientId"
              value={formData.clientId}
              onChange={handleInputChange}
              placeholder="your-client-id"
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Client Secret
            </label>
            <input
              type="password"
              name="clientSecret"
              value={formData.clientSecret}
              onChange={handleInputChange}
              placeholder="your-client-secret"
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Encrypted with your deployment key
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Role Claim (optional)
            </label>
            <input
              type="text"
              name="roleClaim"
              value={formData.roleClaim}
              onChange={handleInputChange}
              placeholder="roles"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              JWT claim that contains user roles (e.g., 'roles' for Entra ID, 'appRoles', 'org_roles')
            </p>
          </div>

          <div className="border-t pt-4 mt-4">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-4">Role Mapping</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Map your identity provider's role values to Renkei roles. Enter the IDP value that should grant each Renkei role.
            </p>

            <div className="space-y-4">
              <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-800/50">
                <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Renkei Operator <span className="text-gray-500 dark:text-gray-400 font-mono">(renkei-operator)</span>
                </label>
                <input
                  type="text"
                  name="operatorRoleMapping"
                  value={formData.operatorRoleMapping}
                  onChange={handleInputChange}
                  placeholder="e.g., admin, platform-admin"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                  Permissions: view all logs, manage IDP configuration, revoke other users' sessions
                </p>
              </div>

              <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-800/50">
                <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Renkei User <span className="text-gray-500 dark:text-gray-400 font-mono">(renkei-user)</span>
                </label>
                <input
                  type="text"
                  name="userRoleMapping"
                  value={formData.userRoleMapping}
                  onChange={handleInputChange}
                  placeholder="e.g., user, member"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                  Permissions: view own logs, revoke own sessions
                </p>
              </div>
            </div>
          </div>

          {message && (
            <div
              className={`p-3 rounded-lg text-sm ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
              }`}
            >
              {message.text}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !discoveryValidated}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-4 rounded-lg transition-colors"
          >
            {isLoading ? 'Saving...' : discoveryValidated ? 'Save Identity Provider Configuration' : 'Test discovery endpoint first'}
          </button>
        </form>

        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <h2 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">What is OIDC?</h2>
          <p className="text-sm text-blue-800 dark:text-blue-200">
            OpenID Connect allows your users to sign in with your organization's identity provider.
            Once configured, your team can access this MCP using their work account.
          </p>
        </div>

        <p className="text-center text-sm text-gray-500 dark:text-gray-500 mt-12">
          Renkei — Jira work item gateway
        </p>
      </main>
    </div>
  );
}

export default function CreateOrganization() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CreateOrganizationContent />
    </Suspense>
  );
}
