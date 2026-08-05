import { NextRequest, NextResponse } from 'next/server';
import { clearOperatorCookie } from '@/lib/auth-utils';

export async function POST(_request: NextRequest): Promise<NextResponse> {
  await clearOperatorCookie();
  return NextResponse.json({ success: true });
}
