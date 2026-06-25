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
- That primary toolbar should use two rows and keep the same order across views. The first row is search. The second row is sort (`DirectorySortMenu`), then the grouping control (`DirectoryGroupingMenu`) when present, then the Filters button (`DirectoryFiltersMenu`) when the view has extra filters, on the left; rows/items per page (`DirectoryPageSizeMenu`) and view mode are anchored together at the right end. When the row is too narrow to fit the separate controls (a phone, or a tight modal), the sort/grouping/filters controls automatically collapse into a single combined dropdown so the row stays on one line; when there is room again they break back out into the separate buttons. `DirectoryPrimaryToolbar` measures its own width (`ResizeObserver`) to decide. Pass it the structured `filters={{ activeCount, onClear, clearDisabled, children }}` and `grouping={{ value, options, onChange }}` props (not pre-built nodes) so it can render either form. `compactControls` only sets the initial guess before the first measurement (use it in modals so they start combined and break out if wide); it does not force the layout. All four controls are the **same kind of dropdown button** (an outlined neutral `MenuButton` with a leading icon, the current value, and a chevron — styled to read like the native printers "View:" select) and the **same compact size** (bounded min/max width), not stretched; they stay neutral-colored regardless of active state and truncate rather than wrap so long values never move or stack the controls. Sort is a single button whose panel lists the sort fields **and** Ascending/Descending, so field and direction both live inside the one control (not a separate adjacent toggle); its leading icon mirrors the direction. The current value in a single-select panel uses Joy's `selected` highlight only — **no checkmark**. Checkmarks (`MultiSelectOption`) are reserved for multi-select dropdowns (the filter facets), where they signal more than one value can be picked.
- Put extra per-view filters into the shared `DirectoryFiltersMenu` dropdown (passed as the toolbar's `filtersButton`), not inline in the toolbar and not a modal dialog. Filter `Select`s inside the menu must set `slotProps={{ listbox: { disablePortal: true } }}` so opening one doesn't dismiss the panel. Views with no extra filters can omit the Filters button entirely.
- Facet-style filters (where a value picks from a set — file type, printer model, role, profile type, etc.) are **multi-select**: a `Select multiple` whose options are `MultiSelectOption` (leading check on the selected values), with a `renderValue` summary and a `placeholder` shown when nothing is picked. Model the state as an array where **empty means "no filter" / all** (no `__all__` sentinel option); matching is OR within a facet and AND across facets. Reserve single-select for true either/or filters (e.g. an enabled/disabled status).
- Do not render an active-filter chip/clear-filters summary row below the toolbar. The Filters dropdown (`DirectoryFiltersMenu`) shows the current filter state and provides its own Clear action; reopening it is how users review and reset filters. Render the paginated list or table content directly after the toolbar.
- For paginated sections, show the shared pagination row both above and below the paged content.
- Keep `Showing x-y of z` on the left, with `Previous` and `Next` grouped on the right.
- When the user changes pages, scroll the section back to the top pagination row.
- Keep pagination rows outside scrollable table or sheet wrappers so the controls do not appear inside the data surface.
- Reuse the shared pagination components instead of hand-rolling per-view variants.
- Library file pickers (the print dialog, order picker, and file picker) must reuse the same building blocks as the Library page so search, sort, grouping, filters, and pagination stay identical: drive filter/page state with the `useLibraryFilters` hook, render the toolbar with `DirectoryPrimaryToolbar` (filters children = `LibraryMetadataFilters`, `disabled` = `libraryFacetsEmpty`), and render results with `PaginatedLibraryBrowser` (passing a `renderBrowser` that returns a `LibraryBrowser`). Do not hand-roll a picker toolbar or a bespoke grouped/paginated browser.

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