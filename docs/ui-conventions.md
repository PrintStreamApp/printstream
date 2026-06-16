# UI Conventions

These conventions capture patterns already used across the web app and the cleanup decisions we want to preserve.

## Page structure

- Give each top-level view one primary page heading.
- Do not add a redundant top-level back button when the page already lives in first-level app navigation.
- Do not stack a second heading that repeats the page title immediately inside the first section or card.
- For top-level sections, place the section heading and helper text before the related card or surface. Do not bury section titles and section-level subtext inside the top-level card itself.
- Use shared navigation structure for dense pages: top-level navigation stays in `AppShell`, and long settings-style pages use `SectionNav` instead of ad-hoc anchor bars.

## Copy and tone

- Write UI copy for users, not for developers. Prefer action- and outcome-focused text over implementation notes.
- Avoid internal architecture phrasing unless the user must act on it. Terms like platform mode, tenant context, provider internals, or bootstrap flows should stay out of user-facing helper copy unless they are the subject of the screen.
- Helper text should explain what the action changes, what the state means, or what the user should do next.
- Label soft-deletes by their destination: actions that move items to the recycle bin say "Move to recycle bin" (or "Recycle"), never "Delete". Reserve "Delete" for operations that permanently destroy data (folder deletion, recycle-bin purge, printer SD files).
- When showing a filament/material colour, prefer the friendly colour name over the raw hex code wherever one can be resolved (`resolveFilamentSwatchName`, `resolveProjectFilamentColorName`, `commonFilamentColorName` in `apps/web/src/lib/filamentColor.ts`). Fall back to the hex string only when no name matches; the swatch itself still conveys the exact colour.

## Layout and width

- Constrain width at the page, card, or section container level.
- Do not add `maxWidth` to `Typography` or other text nodes when the surrounding layout already wraps and constrains content.
- Prefer Joy layout primitives (`Stack`, `Sheet`, `Card`, `Box`) and existing shared wrappers before adding one-off sizing rules.
- For directory-style sections such as users, tenants, jobs, or other filterable lists, keep the primary toolbar in the main section flow above the data surface instead of nesting it inside an extra inset filter card or soft sheet.
- That primary toolbar should use two rows and keep the same order across views: the first row is search followed by the Filters button when the view has extra filters; the second row is sort, then rows/items per page, then view mode aligned to the right when the screen supports list/icon switching.
- Put extra per-view filters into a dedicated Filters dialog instead of keeping them inline in the toolbar. Views with no extra filters can omit the dialog and Filters button.
- Follow the toolbar with the active-filter summary row: any active filter chips, then a clear-filters action when applicable. Render the paginated list or table content after that summary row.
- For paginated sections, show the shared pagination row both above and below the paged content.
- Keep `Showing x-y of z` on the left, with `Previous` and `Next` grouped on the right.
- When the user changes pages, scroll the section back to the top pagination row.
- Keep pagination rows outside scrollable table or sheet wrappers so the controls do not appear inside the data surface.
- Reuse the shared pagination components instead of hand-rolling per-view variants.

## Tables

- Use Joy `Table` inside an outlined `Sheet` for desktop data tables.
- Prefer Joy's default fixed table layout. Size narrow columns by setting widths on the relevant `<th>` elements instead of overriding the whole table layout model.
- Use `size="sm"`, `borderAxis="xBetween"`, and `hoverRow` as the baseline for standard directory-style tables. Add `stripe="odd"` when row separation benefits scanability.
- When the first column identifies the row, render that body cell as `<th scope="row">` instead of a plain `<td>`.
- For desktop tables, every visible column that supports sorting should expose a clickable header control in the header cell. Keep non-sortable columns as static labels.
- Reuse the shared sortable header pattern so active sort state uses the same Joy `Button` treatment and arrow affordance across tables.
- Keep separate sort dropdowns only when mobile cards need them or when the screen exposes additional sort modes that do not map to visible columns.

## Feedback surfaces

- Use Joy `Alert` for notices, warnings, and errors.
- Add a `startDecorator` icon when it improves scanability or severity recognition. Match the icon to the alert meaning and color.
- Do not add icons to every alert by default; decoration should clarify state, not create noise.
- Reuse shared empty-state and dialog primitives (`EmptyState`, `BackAwareModal`, `ScrollableDialog`) so empty content and modal behavior stay consistent across mobile and desktop layouts.
- All dialogs should stay viewport-bounded by default. Rely on the shared modal sizing guardrails, and use `ScrollableModalDialog` plus `ScrollableDialogBody` for longer forms or detail panes instead of hand-rolling fixed-height scroll regions.

## Dialog section framing

- Multi-section dialogs should render each major content group as a titled section, with the title and any helper copy outside the surface that contains the controls.
- Use an outlined `Sheet` or `Card` for the section body so scanners can distinguish groups like location, pickers, compatibility, settings, warnings, and review states.
- Do not leave major dialog groups floating directly in the modal body. Breadcrumbs, browser controls, selector clusters, and settings blocks should live inside explicit section surfaces.
- Simple confirm, alert, prompt, and media-viewer dialogs are exempt when they only have one short body region.
- Prefer the shared `DialogSection` helper in `apps/web/src/components/DialogSection.tsx` when the dialog follows the standard `title + optional helper text + outlined section surface` pattern.

## Actions and controls

- Keep primary actions visually obvious and grouped consistently with existing Joy patterns.
- In dialogs, keep confirm/save actions on the right, with cancel/dismiss immediately to their left.
- For confirm and prompt dialogs, always render the dismiss action first and the main action last so the primary or destructive action is the rightmost button. Do not place `Cancel`, `Close`, or `Dismiss` to the right of the dialog's main action.
- Do not use native browser `confirm()` or `prompt()` in app-owned web UI. Use the shared dialog helpers so confirmations and text entry follow the same Joy modal pattern, copy, and mobile behavior everywhere.
- When a card has exactly one primary action, make the whole card clickable instead of adding a separate action button. Use the settings overview card pattern: `Card` as a `button`, a right-side chevron, hover/focus styling, and a descriptive `aria-label`.
- For standalone toolbar or directory-list select boxes, make the selected value self-describing by prefixing it with the control purpose, such as `Status: Enabled users`, `Role: Admin`, `Sort by: Name A-Z`, or `Rows: 25 per page`. Selects with a persistent adjacent `FormLabel` may keep shorter option labels.
- Use `variant` and shared theme tokens before custom `sx` overrides.

## Data loading

- Use `apiFetch` for JSON HTTP requests.
- Pass TanStack Query's `signal` through to `apiFetch` whenever a query function performs HTTP work. This lets route changes, rapid sorting/filtering, tab churn, and disabled queries abort stale requests instead of piling up backend work.
- Poll only when the data cannot reasonably be delivered through the existing WebSocket/event cache. Polling queries should pass abort signals and avoid short intervals unless the view genuinely needs them.

## Shell and auth-aware chrome

- Platform versus tenant theming is route-state driven, not just workspace-access driven.
- Auth and setup routes should suppress workspace-switching chrome that would suggest the user can move between workspaces before they finish the current flow.