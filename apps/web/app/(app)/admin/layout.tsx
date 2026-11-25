import type { ReactNode } from 'react';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import AdminFrame from './admin-nav';

/**
 * The Organization console: its areas behind a sidebar inside the main
 * area (admin-nav.tsx). Only an operator gets the sidebar; anyone else
 * gets the page alone, which tells them they lack the role or sends them
 * to sign in. This is not the access check: a layout does not run again
 * on a client-side navigation, so every page keeps its own guard.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return <div className="mx-auto max-w-4xl">{children}</div>;
  }
  return <AdminFrame>{children}</AdminFrame>;
}
