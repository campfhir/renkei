/** Disconnect from one salesforce-admin connector (org): lib/salesforce-connect-grant.ts. */

import type { NextRequest } from 'next/server';
import { disconnectSalesforce } from '@/lib/salesforce-connect-grant';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';

export function DELETE(request: NextRequest, context: { params: Promise<{ connector: string }> }) {
  return disconnectSalesforce(SALESFORCE_ADMIN_KIND, request, context);
}
