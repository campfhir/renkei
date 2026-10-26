/** Disconnect from one salesforce-admin connector (org): lib/salesforce-connect-grant.ts. */

import type { NextRequest } from 'next/server';
import { disconnectSalesforce } from '@/lib/salesforce-connect-grant';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { routeLog } from '@/lib/log-context';

function DELETEHandler(request: NextRequest, context: { params: Promise<{ connector: string }> }) {
  return disconnectSalesforce(SALESFORCE_ADMIN_KIND, request, context);
}

export const DELETE = routeLog(DELETEHandler);
