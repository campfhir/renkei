import React from 'react';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import BlockEditor from '../block-editor';

/** A new building block, typed in or drafted with AI (`?draft=ai` puts the cursor in the description). */
export default async function NewCiBlockPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) redirect('/admin');
  const { draft } = await searchParams;
  return (
    <div className="mx-auto max-w-6xl">
      <BlockEditor blockId={null} askFirst={draft === 'ai'} />
    </div>
  );
}
