/**
 * Get version and commit information for display.
 * Returns a string like "v1.0.0 (abc1234)" or fallback to commit hash.
 */
export function getVersionInfo(): string {
  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown';
  // APP_VERSION is what the image sets (docker/Dockerfile); npm_package_version
  // is what a `pnpm start` in a checkout surrounds the process with.
  const version =
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.APP_VERSION ||
    process.env.npm_package_version ||
    'dev';

  if (version === 'dev' && commit !== 'unknown') {
    return commit.substring(0, 7);
  }

  return `${version} (${commit.substring(0, 7)})`;
}
