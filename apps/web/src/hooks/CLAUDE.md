# apps/web/src/hooks — domain guides

- `usePrinterWebSocket.ts` (and any WS/event-subscription hook) → `.claude/guides/data-event-contract.md`. Treat WS events as cache-invalidation hints, not authorization proof; read live printer state from the workspace-scoped React Query cache.
