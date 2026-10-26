'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-logs';

/**
 * Reports the errors a page does not handle itself: uncaught exceptions and
 * promises that reject with nothing waiting on them. Mounted once, in the
 * root layout.
 */
export default function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
