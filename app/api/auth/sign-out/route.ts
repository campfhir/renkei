import { NextRequest, NextResponse } from 'next/server';
import { clearOperatorCookie } from '@/lib/auth-utils';

export async function POST(request: NextRequest) {
  await clearOperatorCookie();
  return NextResponse.json({ success: true });
}
