'use client';

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from './shortcuts';

const subscribe = () => () => {};

/**
 * The keyboard's platform. The server render has no browser to ask and says
 * 'other'; the client's first paint says what it is, without a hydration
 * mismatch.
 */
export function usePlatform(): Platform {
  return useSyncExternalStore(
    subscribe,
    () => detectPlatform(navigator),
    () => 'other'
  );
}
