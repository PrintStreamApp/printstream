# UI conventions

Read this when working in the web app (`apps/web/**`).

Treat `docs/ui-conventions.md` as the human-readable source of truth for the rules below and keep this file aligned with it.

- Give each top-level view one primary heading. Do not add redundant top-level back buttons or duplicate heading stacks immediately inside the page.
- For top-level sections, render the section heading and helper text before the related card or surface. Do not place section-level titles or subtext inside the top-level card itself.
- Keep copy user-facing and action-oriented. Avoid developer- or architecture-targeted helper text unless the screen explicitly needs that terminology.
- Soft-deletes say "Move to recycle bin"/"Recycle"; "Delete" is reserved for permanent destruction.
- Show friendly colour names instead of raw hex wherever a name can be resolved (`filamentColor.ts` helpers: `resolveFilamentSwatchName`, `resolveProjectFilamentColorName`, `commonFilamentColorName`); fall back to hex only when no name matches.
- Constrain width at the page, card, or section container level. Avoid `maxWidth` on `Typography` or other text nodes when the parent surface already wraps naturally.
- For directory-style sections such as users, tenants, jobs, or other filterable lists, keep the primary toolbar in the main section flow above the data surface instead of nesting it inside an extra inset filter card or soft sheet.
- Keep that toolbar ordered consistently across views in two rows: search first and the Filters button beside it when present; then sort, rows/items per page, and view mode aligned right when the screen supports list/icon switching.
- Put extra per-view filters into a dedicated Filters dialog instead of keeping them inline in the toolbar. Views with no extra filters can omit the dialog and Filters button.
- Place the active-filter summary row between the toolbar and the paginated list or table content: active filter chips and a clear-filters action when applicable.
- For paginated sections, show the shared pagination row both above and below the paged content.
- Keep `Showing x-y of z` on the left and `Previous` / `Next` grouped on the right in the same row.
- When the user changes pages, scroll the section back to the top pagination row.
- Keep pagination rows outside scrollable table or sheet wrappers so the controls do not appear inside the data surface.
- Reuse the shared pagination components instead of hand-rolling per-view variants.
- Use `apiFetch` for JSON HTTP requests.
- Pass TanStack Query's `signal` through to `apiFetch` whenever a query function performs HTTP work so route changes, rapid sorting/filtering, tab churn, and disabled queries abort stale requests instead of piling up backend work.
- Poll only when the data cannot reasonably be delivered through the existing WebSocket/event cache. Polling queries should pass abort signals and avoid short intervals unless the view genuinely needs them.
- Use Joy `Table` inside an outlined `Sheet` for desktop data tables.
- Prefer Joy's default fixed table layout. Size narrow columns on the relevant `<th>` elements instead of overriding the whole table layout.
- Use `size="sm"`, `borderAxis="xBetween"`, and `hoverRow` as the baseline for standard directory-style tables; add `stripe="odd"` when extra row separation helps scanning.
- When the first column identifies the row, render that body cell as `<th scope="row">`.
- For desktop tables, every visible sortable column should expose a clickable header control in the header cell. Keep non-sortable columns as static labels.
- Reuse the shared sortable table header pattern so active sort state and arrow affordances stay consistent across screens.
- Keep separate sort dropdowns only when mobile cards still need them or when the screen exposes additional sort modes that do not map to visible columns.
- Use Joy `Alert` for notices, warnings, and errors. Add a `startDecorator` icon when it improves scanability or severity recognition, but do not decorate every notice by default.
- Reuse shared web primitives such as `EmptyState`, `SectionNav`, `BackAwareModal`, and `ScrollableDialog` before introducing one-off patterns.
- Keep dialogs viewport-bounded by default. Rely on the shared modal sizing guardrails, and prefer `ScrollableModalDialog` with `ScrollableDialogBody` for longer forms or detail panes instead of custom fixed-height scroll wrappers.
- For multi-section dialogs, render each major content group as a titled section with the title outside an outlined `Sheet` or `Card`. Do not leave major picker, settings, or review groups floating directly in the modal body.
- Simple confirm, alert, prompt, and media-viewer dialogs are exempt when they only have one short body region.
- Prefer the shared `DialogSection` helper for the common `title + optional helper text + outlined section surface` pattern.
- Keep primary actions visually obvious and grouped consistently with existing Joy patterns. In dialogs, keep confirm/save actions on the right, with cancel/dismiss immediately to their left.
- For confirm and prompt dialogs, always render the dismiss action first and the main action last so the primary or destructive action is the rightmost button. Do not place `Cancel`, `Close`, or `Dismiss` to the right of the dialog's main action.
- Do not use native browser `confirm()` or `prompt()` in app-owned web UI. Use the shared dialog helpers so confirmations and text-entry prompts stay visually and behaviorally consistent.
- When a card has exactly one primary action, make the whole card clickable instead of adding a separate action button. Use the settings overview card pattern: `Card` as a `button`, a right-side chevron, hover/focus styling, and a descriptive `aria-label`.
- For standalone toolbar or directory-list select boxes, make the selected value self-describing by prefixing it with the control purpose, such as `Status: Enabled users`, `Role: Admin`, `Sort by: Name A-Z`, or `Rows: 25 per page`. Selects with a persistent adjacent `FormLabel` may keep shorter option labels.
- Use `variant`, `color`, shared theme tokens, and existing Joy primitives before custom `sx` overrides or new wrappers.
- Platform-versus-tenant theme and workspace-switcher chrome are route-state driven. Reuse the helpers in `src/lib/authRoute.ts` instead of duplicating those heuristics in page components.
