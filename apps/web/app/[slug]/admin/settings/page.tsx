import React from 'react';
import { getOperatorAccess } from '@/lib/operator-access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await getOperatorAccess(tenantRef.id))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2>Error</h2>
        <p>Unable to connect to the database. Please try again later.</p>
      </div>
    );
  }
  const db = dbResult.val;

  let oidcConfigured = false;
  try {
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (tenant) {
      const oidc = await db
        .selectFrom('tenant_oidc')
        .select(['issuer'])
        .where('tenant_id', '=', tenant.id)
        .executeTakeFirst();
      oidcConfigured = !!oidc;
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
  }

  return (
    <div>
      <h2>Settings</h2>
      <section style={{ marginTop: '2rem' }}>
        <h3>Authentication</h3>
        <p>
          OIDC: <strong>{oidcConfigured ? '✓ Configured' : 'Not configured'}</strong>
        </p>
      </section>
      <section style={{ marginTop: '2rem' }}>
        <h3>Organization</h3>
        <p>
          Slug: <code>{slug}</code>
        </p>
      </section>
    </div>
  );
}
