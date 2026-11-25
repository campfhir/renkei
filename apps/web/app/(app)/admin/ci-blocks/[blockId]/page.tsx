import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { isUuid } from '@/lib/uuid';
import BlockEditor from '../block-editor';

/** One building block's editor. */
export default async function CiBlockPage({
  params,
}: {
  params: Promise<{ blockId: string }>;
}): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) redirect('/admin');
  const { blockId } = await params;
  if (!isUuid(blockId)) notFound();
  return (
    <div className="max-w-6xl">
      <BlockEditor blockId={blockId} askFirst={false} />
    </div>
  );
}
