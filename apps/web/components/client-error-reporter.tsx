'use client';

/**
 * Reports what the page itself never caught (an uncaught exception, a
 * rejected promise nobody awaited) through the client logger, so it reaches
 * the person's Activity view instead of only the browser console. Mounted
 * once in the app shell; renders nothing.
 */

import { useEffect } from 'react';
import { clientLogger } from '@/lib/client-logger';

export default function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      clientLogger.error('window', 'uncaught error', event.error ?? event.message, {
        source: event.filename || undefined,
        line: event.lineno || undefined,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      clientLogger.error('window', 'unhandled promise rejection', event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
