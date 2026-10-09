'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function CreateOrganizationContent() {
  const searchParams = useSearchParams();
  const domain = searchParams.get('domain') || '';
  const tenantId = searchParams.get('tenantId') || '';
  // The sign-in page sends a domain here with pending=1 when a tenant has
  // claimed it but not yet proven control of it (api/home-realm/route.ts).
  const pending = searchParams.get('pending') === '1';

  const [formData, setFormData] = useState({
    discoveryEndpoint: '',
    clientId: '',
    clientSecret: '',
    roleClaim: 'roles',
    groupsClaim: 'groups',
    operatorRoleMapping: '',
    userRoleMapping: '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [discoveryValidated, setDiscoveryValidated] = useState(false);
  const [discoveryInfo, setDiscoveryInfo] = useState<{
    issuer: string;
    authEndpoint?: string;
    tokenEndpoint?: string;
  } | null>(null);
  // What only the creator receives when the tenant is minted
  // (api/home-realm/create): the one-time secret the identity-provider
  // save must present, and the TXT record to publish before the sign-in
  // page routes this domain here.
  const [onboarding, setOnboarding] = useState<{
    bootstrapSecret: string;
    record: string;
    recordDomain: string;
  } | null>(null);
  const [configured, setConfigured] = useState(false);
  const [verification, setVerification] = useState<{
    state: 'idle' | 'checking' | 'verified' | 'not-yet' | 'error';
    detail?: string;
  }>({ state: 'idle' });

  const verifyDomain = async () => {
    if (!onboarding) return;
    setVerification({ state: 'checking' });
    try {
      const response = await fetch(`/api/verify-domain`, {
        method: 'POST',
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.verified === true) {
        setVerification({ state: 'verified' });
        return;
      }
      if (response.status === 409 && data.verified === false) {
        const reasons: string[] = Array.isArray(data.domains)
          ? data.domains.map(
              (d: { domain?: string; reason?: string }) => `${d.domain}: ${d.reason}`
            )
          : [];
        setVerification({ state: 'not-yet', detail: reasons.join('; ') });
        return;
      }
      setVerification({
        state: 'error',
        detail: data.error || `Server returned ${response.status}`,
      });
    } catch (error) {
      setVerification({
        state: 'error',
        detail: error instanceof Error ? error.message : 'Could not reach the server',
      });
    }
  };

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
        setDiscoveryValidated(false);
        setDiscoveryInfo(null);
        setMessage({
          type: 'error',
          text: `Server returned ${response.status}`,
        });
        setIsLoading(false);
        return;
      }

      const discovery = await response.json();

      if (!discovery.issuer) {
        setDiscoveryValidated(false);
        setDiscoveryInfo(null);
        setMessage({
          type: 'error',
          text: 'Discovery endpoint missing issuer field',
        });
        setIsLoading(false);
        return;
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
      let actualTenantId = tenantId || onboarding?.tenantId || '';
      let bootstrapSecret = onboarding?.bootstrapSecret ?? '';

      // If no tenant ID, create one for this domain
      if (!actualTenantId && domain) {
        const createResponse = await fetch(`/api/home-realm/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });

        if (!createResponse.ok) {
          const error = await createResponse.json();
          setMessage({
            type: 'error',
            text: error.error || 'Failed to create tenant',
          });
          setIsLoading(false);
          return;
        }

        const created = await createResponse.json();
        actualTenantId = created.tenantId;
        bootstrapSecret = created.bootstrapSecret ?? '';
        setOnboarding({
          bootstrapSecret,
          record: created.domainVerification?.record ?? '',
          recordDomain: created.domainVerification?.domain ?? domain,
        });
      }

      if (!actualTenantId) {
        setMessage({
          type: 'error',
          text: 'Unable to determine tenant ID',
        });
        setIsLoading(false);
        return;
      }

      const response = await fetch(`/api/oidc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The first configuration is accepted only from whoever created the
          // tenant: the one-time secret the create call returned.
          ...(bootstrapSecret ? { 'X-Renkei-Bootstrap-Secret': bootstrapSecret } : {}),
        },
        body: JSON.stringify({
          discoveryEndpoint: formData.discoveryEndpoint,
          clientId: formData.clientId,
          clientSecret: formData.clientSecret,
          roleClaim: formData.roleClaim,
          groupsClaim: formData.groupsClaim || undefined,
          operatorIdpValue: formData.operatorRoleMapping || undefined,
          userIdpValue: formData.userRoleMapping || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        setMessage({
          type: 'error',
          text: error.error || 'Failed to configure OIDC',
        });
        setIsLoading(false);
        return;
      }

      setMessage({ type: 'success', text: 'Organization configured successfully!' });
      setConfigured(true);
      if (!onboarding && !bootstrapSecret) {
        // An existing tenant (tenantId in the URL): nothing to verify here.
        // Straight into the OIDC flow they just configured — prove the login
        // works, then land on the tenant's home page (the callback's default).
        setTimeout(() => {
          window.location.href = `/api/auth/oidc/login?tenantId=${actualTenantId}`;
        }, 1500);
      }
      setIsLoading(false);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'An error occurred',
      });
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
          {domain
            ? `Configure OIDC for ${domain}`
            : 'Configure your organization identity provider'}
        </p>

        {pending && (
          <div
            className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100"
            data-testid="domain-pending"
          >
            <p className="font-semibold">{domain} is waiting for domain verification.</p>
            <p className="mt-1">
              Someone has set this organization up, but sign-in from the home page stays off until
              the <code className="font-mono">renkei-verify=…</code> TXT record they were given is
              published on <code className="font-mono">{domain}</code> and verified. If that was
              you, use the verification step from the page where you created the organization; if
              not, ask your IT team.
            </p>
          </div>
        )}

        {configured && onboarding && (
          <div
            className="mb-6 space-y-3 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-900/20 dark:text-green-100"
            data-testid="domain-verification-steps"
          >
            <p className="font-semibold">
              One more step: prove you control {onboarding.recordDomain}
            </p>
            <p>
              Until this record is published and verified, the home page will not route{' '}
              <code className="font-mono">@{onboarding.recordDomain}</code> addresses to your
              organization. Add a DNS record at your domain registrar:
            </p>
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-green-800 dark:text-green-200">Type</dt>
              <dd>TXT</dd>
              <dt className="text-green-800 dark:text-green-200">Host</dt>
              <dd>{onboarding.recordDomain}</dd>
              <dt className="text-green-800 dark:text-green-200">Value</dt>
              <dd className="break-all" data-testid="domain-verification-record">
                {onboarding.record}
              </dd>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void verifyDomain()}
                disabled={verification.state === 'checking' || verification.state === 'verified'}
                className="rounded-lg bg-green-700 px-3 py-1.5 font-medium text-white hover:bg-green-800 disabled:bg-gray-400"
              >
                {verification.state === 'checking'
                  ? 'Checking DNS…'
                  : verification.state === 'verified'
                    ? 'Verified'
                    : 'Verify now'}
              </button>
              <a
                href={`/api/auth/oidc/login?tenantId=${onboarding.tenantId}`}
                className="text-blue-700 underline dark:text-blue-300"
              >
                Continue to sign in
              </a>
            </div>
            {verification.state === 'not-yet' && (
              <p className="text-amber-800 dark:text-amber-200">
                Not visible yet{verification.detail ? ` (${verification.detail})` : ''}. DNS changes
                can take a few minutes to appear; come back to the home page and sign in with your
                work email once it has, or try again.
              </p>
            )}
            {verification.state === 'error' && (
              <p className="text-red-800 dark:text-red-200">{verification.detail}</p>
            )}
            <p className="text-xs">
              Keep this page open until you have saved the record: the value above is shown only
              now. The onboarding secret used to save this configuration has already been spent.
            </p>
          </div>
        )}

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
                <p className="text-sm font-medium text-green-900 dark:text-green-100 mb-2">
                  ✓ Discovery validated
                </p>
                <div className="text-xs text-green-800 dark:text-green-200 space-y-1">
                  <p>
                    <strong>Issuer:</strong> {discoveryInfo.issuer}
                  </p>
                  {discoveryInfo.authEndpoint && (
                    <p>
                      <strong>Auth:</strong> {discoveryInfo.authEndpoint}
                    </p>
                  )}
                  {discoveryInfo.tokenEndpoint && (
                    <p>
                      <strong>Token:</strong> {discoveryInfo.tokenEndpoint}
                    </p>
                  )}
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
              JWT claim that contains user roles (e.g., 'roles' for Entra ID, 'appRoles',
              'org_roles')
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Groups Claim (optional)
            </label>
            <input
              type="text"
              name="groupsClaim"
              value={formData.groupsClaim}
              onChange={handleInputChange}
              placeholder="groups"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              JWT claim that lists the user's groups. Recorded at each sign-in so connectors can be
              offered to some groups and not others. Configure your identity provider to include it
              in the ID token ('groups' for Entra ID group claims).
            </p>
          </div>

          <div className="border-t pt-4 mt-4">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-4">Role Mapping</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Map your identity provider's role values to Renkei roles. Enter the IDP value that
              should grant each Renkei role.
            </p>

            <div className="space-y-4">
              <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-800/50">
                <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Renkei Operator{' '}
                  <span className="text-gray-500 dark:text-gray-400 font-mono">
                    (renkei-operator)
                  </span>
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
                  Renkei User{' '}
                  <span className="text-gray-500 dark:text-gray-400 font-mono">(renkei-user)</span>
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
            {isLoading
              ? 'Saving...'
              : discoveryValidated
                ? 'Save Identity Provider Configuration'
                : 'Test discovery endpoint first'}
          </button>
        </form>

        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <h2 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">What is OIDC?</h2>
          <p className="text-sm text-blue-800 dark:text-blue-200">
            OpenID Connect allows your users to sign in with your organization's identity provider.
            Once configured, your team can access this MCP using their work account.
          </p>
        </div>
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
