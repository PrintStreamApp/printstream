/**
 * The API package emits no type declarations, and `run.ts` imports its server
 * entry purely for the side effect of booting it. Declare the module so the
 * side-effect `import('@printstream/api/server')` resolves without types.
 */
declare module '@printstream/api/server'
