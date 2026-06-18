/**
 * The bridge package emits no type declarations and `in-box-bridge.ts` only
 * constructs the runtime and fires `start()`. Declare the minimal surface so the
 * dynamic import types cleanly without pulling the bridge's full type graph.
 */
declare module '@printstream/bridge/runtime' {
  export class BridgeRuntimeClient {
    start(): Promise<void>
  }
}
