/**
 * Wire contract for telling a browser which web bundle the server is serving, so a tab
 * running an older one can notice and reload itself.
 *
 * Two channels carry the same value, because neither covers every surface on its own:
 * the `hello` WS frame (`wsHelloEventSchema.webBuildId`) is immediate on reconnect but
 * only exists on workspace routes, and this response header reaches everything that
 * makes an API call, including the PWA's `start_url` and the public tools, which hold no
 * socket. Producer: `apps/api/src/lib/web-build-id.ts`. Consumer:
 * `apps/web/src/lib/appStaleness.ts`.
 */

/**
 * Response header naming the served bundle's build id.
 *
 * Sent only when the server actually knows what it is serving; an absent header means
 * "unknown" and must never be read as "you are stale". Must appear in the CORS
 * `exposedHeaders` list, or a split-topology browser cannot read it at all.
 */
export const WEB_BUILD_ID_HEADER = 'X-PrintStream-Web-Build'
