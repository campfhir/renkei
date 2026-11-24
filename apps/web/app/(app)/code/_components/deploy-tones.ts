/** The colours a deployment's tone takes on both Deployments pages. */
export const DOT = {
  good: 'bg-green-600',
  running: 'bg-blue-600',
  bad: 'bg-red-600',
  none: 'bg-gray-400',
} as const;

export const PILL = {
  good: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  none: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
} as const;

export const NOTE = {
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
} as const;

export const card = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
