/**
 * Get version and commit information for display.
 * Returns a string like "v1.0.0 (abc1234)" or fallback to commit hash.
 */
export function getVersionInfo(): string {
  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown';
  const version = process.env.NEXT_PUBLIC_APP_VERSION || process.env.npm_package_version || 'dev';

  if (version === 'dev' && commit !== 'unknown') {
    return commit.substring(0, 7);
  }

  return `${version} (${commit.substring(0, 7)})`;
}
