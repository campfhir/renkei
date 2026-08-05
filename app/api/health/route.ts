import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export async function GET(): Promise<NextResponse> {
  logger.debug('[Health] Ping');
  return NextResponse.json({ status: 'ok' });
}
