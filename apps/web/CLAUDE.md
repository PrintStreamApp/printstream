# Web (apps/web)

Applies when working in the Vite web app, Joy UI components, PWA shell, or client data loading.

- Mobile-friendly. Verify changes at a 375px-wide viewport before widening.
- Preserve the dark, atmospheric visual direction defined in `src/theme/theme.ts`. Prefer Joy UI components and CSS variables over custom one-off styles.
- Live printer state lives in the workspace-scoped React Query cache keyed by `workspaceQueryKeys.printerStatus(scopeKey)`, kept fresh by the WS subscription in `src/hooks/usePrinterWebSocket.ts`. Read from that cache; do not poll.
- Use `apiFetch` from `src/lib/apiClient.ts` for JSON requests so error handling stays consistent.
- Pass TanStack Query's `signal` through to `apiFetch` whenever a query function performs HTTP work so stale requests are aborted on route changes, rapid sorting/filtering, tab churn, or disabled queries.
- Build URLs with `buildApiUrl`/`buildWebSocketUrl`. Read env via `getBrowserEnv()`.
- Validate parsed WS payloads with the shared Zod schemas (`wsEventSchema`).
- Keep heavy dependencies inside plugins or narrowly owned modules; follow the current eager-loading app shell unless the task explicitly calls for changing that startup strategy.
- For branded SVG assets in `apps/web/public`, keep the SVG as the source of truth. If a PNG export is needed, render it from a browser by capturing the SVG element itself and then write the normalized square PNG outputs from that browser render instead of relying on a CLI SVG rasterizer.
- Keep copy user-facing and action-oriented. Avoid developer- or architecture-targeted helper text unless the screen explicitly needs that terminology.
- Top-level views get one primary heading. Do not add redundant top-level back buttons or duplicate heading stacks immediately inside the page.
- For top-level sections, put the section heading and helper text above the related card or surface instead of inside the top-level card.
- Constrain width at the layout container, not individual text nodes. Avoid `maxWidth` on `Typography` when the parent surface already wraps content naturally.
- Use Joy `Alert` with a `startDecorator` when iconography improves scanability or severity recognition, but do not decorate every notice by default.
- Reuse shared web primitives such as `EmptyState`, `SectionNav`, `BackAwareModal`, and `ScrollableDialog` before introducing one-off patterns.
- Auth/setup route chrome is controlled by the helpers in `src/lib/authRoute.ts`; do not duplicate platform-vs-tenant theme or workspace-switcher heuristics in page components.
- Component render tests bootstrap jsdom via `installJsdomGlobals()` from `src/test-utils/jsdom.ts` (returns the `JSDOM`; accepts a URL and a dynamic `matchMedia` matcher). Reuse it instead of re-pasting the `matchMedia`/`globalThis` setup block; add only test-specific extras (`fetch`, `confirm`) afterward.

> For the full view-layout, directory-toolbar, table, pagination, and dialog conventions, read `.claude/guides/ui-conventions.md`.

### Other guides that reach into the web app

- `Auth*` components, `SettingsView`, `PlatformView`, `src/lib/auth*.ts`, `auth-*` plugins → `.claude/guides/auth-architecture.md`.
- `usePrinterWebSocket`, `src/lib/ws*.ts`, `apiClient.ts`, `workspaceContext.ts`, `*QueryInvalidation.ts` → `.claude/guides/data-event-contract.md`.
- `PrintersView.tsx` and printer-capability UI → `.claude/guides/printer-driver-migration.md`.
- Web plugins and the plugin host → `.claude/guides/plugins.md`.

## Dialogs

- Follow the common Material/web convention for dialog footers: place actions on the right, with the **primary / confirm action as the rightmost button** and **Cancel / Close / Dismiss to its left** (typically `variant="plain"`). Destructive actions sit in the primary slot when they are the dialog's main intent (e.g. an "Uninstall plugin?" confirmation), styled with `color="danger"`.
- For confirm and prompt dialogs specifically, always render the dismiss action first and the main action last. Never place `Cancel`, `Close`, or `Dismiss` to the right of the dialog's main action.
- For dialogs with a tertiary destructive action (e.g. a "Remove" button on an edit form), keep that action visually separated on the left side of the footer; Save/Cancel still pair on the right with Cancel innermost.

## Joy UI conventions

- **Always consult the Joy UI docs first.** Before writing custom layouts, overrides, or styling tricks, search the [Joy UI component reference](https://mui.com/joy-ui/getting-started/) for an existing recipe. The library ships dedicated primitives for most patterns we reach for — e.g. structural card sections (`CardOverflow`, `CardCover`, `CardContent`, `CardActions`, `Divider`), bottom action rows (`CardActions`), full-bleed strips with matching corner radii (`CardOverflow`), split buttons (`ButtonGroup` + anchored `Menu`), inverted-color regions (`invertedColors` on `Card`/`Sheet`). Use these instead of hand-rolled negative margins, `borderRadius: 'inherit'`, manual hairlines, or `overflow: hidden` clipping hacks.
- **Treat custom styling as the fallback, not the starting point.** Before adding bespoke `sx` layout rules, wrapper `Box` elements, or selector-based overrides, first check whether the component API, Joy docs, examples, `slotProps`, or built-in CSS variables already cover the need. Only reach for custom structure or styling after you can name the missing Joy primitive or prop.
- **Reach for Joy's built-in patterns before writing custom overrides.** Check the Joy UI docs / examples for the canonical recipe first. For instance, a split button is `ButtonGroup` containing a `Button` + an `IconButton`, with an anchor `ref` driving a `Menu` via `anchorEl` and `open` — not a `Dropdown` + `MenuButton` with hand-rolled border-radius overrides.
- **Check props before selectors.** For layout or appearance changes, prefer component props such as `orientation`, `spacing`, `buttonFlex`, `sticky`, `invertedColors`, `size`, `variant`, `color`, and documented slot props before adding `& > *`, descendant selectors, or extra wrappers. If a wrapper is unavoidable, preserve the component's expected child layout contract.
- **Layer with theme z-index tokens, not magic numbers.** Joy keeps `zIndex` on `theme.zIndex` (plain numbers) — it is *not* mirrored under `theme.vars` (only palette/typography/etc. are exposed as CSS variables), so `theme.vars.zIndex.X` returns `undefined`. Use `sx={{ zIndex: (theme) => theme.zIndex.tooltip }}`. Full ladder: `badge` (1) < `table` (10) < `popup` (1000) < `modal` (1300) < `snackbar` (1400) < `tooltip` (1500). Use `snackbar` for toast stacks and `tooltip` for popups that must surface above a dialog.
- **Reuse existing CSS variables before inventing new ones.** Joy exposes `--joy-palette-*`, `--joy-radius-*`, `--joy-shadow-*`, `--joy-fontSize-*`, etc., and individual components expose their own (`--Card-padding`, `--ListItem-minHeight`, `--ButtonGroup-radius`, `--ButtonGroup-separatorColor`, `--Input-paddingInline`, ...). Override these via `sx` instead of redefining values from scratch.
- Prefer `variant` / `color` / `size` props over per-element `sx` when the same effect is available globally. Don't manually round corners inside `ButtonGroup` — it handles first/last child radii automatically when given `Button` / `IconButton` children.
- When custom Joy styling is still necessary, keep it narrow and document the missing built-in option in the surrounding code or PR description so future cleanup is straightforward.

## Plugin host

- Built-in web plugins live under `src/plugins/<name>/` and are registered in `src/plugin/builtin.ts`.
- Plugins can contribute additional routes and slot components. Core pages expose extension points with `<PluginSlot name="..." context={...} />`; the slot must render correctly when no plugin is installed.
- Heavy dependencies (Three.js, parsers, etc.) must live inside a plugin or another narrowly owned module — never imported from a core page.
- A plugin must not import another plugin directly.
- First-party **private modules** (marketing site, platform tenant admin) live under `src/private/<name>/` and are discovered by `src/lib/privateModules.ts` via `import.meta.glob`. Core code must never import from `src/private`; App.tsx must keep rendering correct fallbacks when no module is present (public builds). See `docs/open-core.md`.
- See `.claude/guides/plugins.md` for the full plugin contract.
