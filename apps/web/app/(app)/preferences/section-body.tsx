import type { ReactNode } from 'react';

/** A section's heading and the cards under it, the same on every section page. */
export function PreferencesSectionBody({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{description}</p>
      </div>
      {children}
    </div>
  );
}
