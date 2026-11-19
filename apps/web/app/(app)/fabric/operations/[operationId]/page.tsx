import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getDataStore } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { isUuid } from '@/lib/uuid';
import { operationView } from '@/lib/fabric/operation-view';
import OperationView from './operation-view';

/**
 * One Fabric definition fetch, the owner's only. Rendered as it stands;
 * operation-view.tsx then listens for it to change until it ends.
 */
export default async function FabricOperationPage({
  params,
}: {
  params: Promise<{ operationId: string }>;
}): Promise<React.ReactNode> {
  const { operationId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/fabric/operations/${operationId}`));
  if (!isUuid(operationId)) notFound();
  const operation = await getDataStore().fabricOperations.find(session.subject, operationId);
  if (!operation) notFound();
  return (
    <div className="mx-auto max-w-4xl">
      <OperationView initial={operationView(operation)} />
    </div>
  );
}
