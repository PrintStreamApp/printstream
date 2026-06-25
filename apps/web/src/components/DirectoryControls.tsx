/**
 * Shared sort/view-mode types for directory-style views (library, tenants, jobs,
 * pickers, …). The controls themselves live in `DirectoryToolbar.tsx`
 * (`DirectorySortMenu`, `DirectoryGroupingMenu`, `DirectoryPageSizeMenu`,
 * `DirectoryPrimaryToolbar`) and `ViewModeToggle.tsx`.
 */
export type DirectoryViewMode = 'list' | 'icon'
export type DirectorySortDirection = 'asc' | 'desc'

export type DirectorySortOption<T extends string> = {
  value: T
  label: string
}
