/**
 * Test fixture: pins `PLATFORM_ADMIN_EMAIL` BEFORE `env.ts` parses.
 *
 * Import this FIRST in any suite that exercises the workspaceless first-run
 * claim on a cloud-mode process — static imports execute in source order, so a
 * leading side-effect import beats the hoisting that defeats an inline
 * `process.env` assignment. Without it, the claim route refuses with "set
 * PLATFORM_ADMIN_EMAIL" and every downstream assertion fails for the wrong
 * reason.
 */
process.env.PLATFORM_ADMIN_EMAIL = 'admin@example.com'
