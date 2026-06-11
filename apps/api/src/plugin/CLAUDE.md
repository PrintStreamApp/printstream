# apps/api/src/plugin — domain guides

This is the API plugin host (types, registry, builtin wiring). Read `.claude/guides/plugins.md` before changing the plugin contract — `ApiPlugin`, the context surface (`router`, `settings`, `logger`, `printerEvents`, `ws`, `prisma`, `registerPrintGuard`, `registerAuthProvider`, `onShutdown`), and the no-cross-plugin-import rule.
