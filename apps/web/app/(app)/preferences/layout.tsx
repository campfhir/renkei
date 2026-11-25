import type { ReactNode } from 'react';
import PreferencesFrame from './preferences-nav';

/**
 * Preferences, grouped into sections behind a sidebar inside the main
 * area (preferences-nav.tsx). Each section is its own page and reads only
 * what it shows; the pages keep their own session guards.
 */
export default function PreferencesLayout({ children }: { children: ReactNode }) {
  return <PreferencesFrame>{children}</PreferencesFrame>;
}
