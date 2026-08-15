/**
 * Loads .env.development before the integration suite runs.
 *
 * Every other jest config in this repo needs no environment at all — network
 * calls are stubbed. This is the one exception, and it stays an exception:
 * `dotenv.config()` runs here, in a `setupFiles` entry scoped to
 * jest.integration.config.js, rather than in the default config where it
 * would quietly become load-bearing for every suite that happens to read an
 * env var in a test.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.development') });
