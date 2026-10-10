/**
 * The SETUP_SECRET the Playwright dev server runs with, so setup.spec.ts can
 * present the right one and a wrong one. An exported environment wins, the
 * way every other variable the config passes through does.
 */
export const E2E_SETUP_SECRET = process.env.SETUP_SECRET || 'e2e-setup-secret-0123456789abcdef';
