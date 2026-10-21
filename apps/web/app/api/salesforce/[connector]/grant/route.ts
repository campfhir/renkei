/** Disconnect from one salesforce connector (org): lib/salesforce-connect-grant.ts. */

import type { NextRequest } from 'next/server';
import { disconnectSalesforce } from '@/lib/salesforce-connect-grant';
import { SALESFORCE_CRM_KIND } from '@/lib/salesforce-kinds';

export function DELETE(request: NextRequest, context: { params: Promise<{ connector: string }> }) {
  return disconnectSalesforce(SALESFORCE_CRM_KIND, request, context);
}
