/**
 * The parameter table: every object and volume in the project, with the settings that differ, in
 * one grid. BambuStudio's `GUI_ObjectTable` ("Object/Part Setting"), read-only.
 *
 * It answers a question the editor could not answer cheaply before: which of these forty objects
 * carries a setting of its own, and what is it. Finding that out meant opening the settings dialog
 * once per object.
 *
 * **It writes nothing.** Every action routes to the surfaces that already own the write: the tune
 * button opens the same `ProcessSettingsDialog` the sidebar and context menu open, and the select
 * button drives the same selection the viewport does. That is deliberate and worth keeping. The
 * write side has four rules that are easy to get wrong and fail silently -- per-object overrides
 * live on the borrowed slice controller while per-part overrides live on `EditorState`, the two
 * have separate undo stacks, clearing a per-object key must write an explicit `{}` rather than
 * deleting it, and filament-index values are remapped when materials move -- and a grid with
 * in-cell editors would be a second implementation of all four. Studio's has exactly that, and
 * every one of its bugs lives there (its sort reorders rows without reassigning the per-row cell
 * editors, so after any sort the editors belong to the wrong rows).
 *
 * Where it goes beyond Studio, and why each is nearly free here:
 *
 * - **Bulk editing already works.** The settings dialog takes a multi-selection
 *   (`initialOverridesByMember`), so selecting several objects and opening it edits them together,
 *   over all 24 per-object keys. Studio's table has no bulk edit and exposes nine settings.
 * - **Columns are chosen**, not fixed. Studio hard-codes its nine.
 * - **Search and an overridden-only filter.** Studio's search box is commented out of its source.
 *
 * Counterparts: `lib/parameterTable.ts` (rows and cells), `lib/parameterTableColumns.ts` (which
 * settings may be columns), `ParameterTableGrid.tsx` (how a row is drawn).
 */
import { useCallback, useMemo, useState } from 'react'
import {
  Alert, Button, Checkbox, DialogActions, Divider, IconButton, Input, Stack, Typography
} from '@mui/joy'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ViewColumnRoundedIcon from '@mui/icons-material/ViewColumnRounded'
import TableRowsRoundedIcon from '@mui/icons-material/TableRowsRounded'
import { BackAwareModal } from '../../components/BackAwareModal'
import { EmptyState } from '../../components/EmptyState'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { ToolbarMenuButton } from '../../components/DirectoryToolbar'
import { MaximizeDialogButton } from '../../components/DialogPresentationToggles'
import { useDialogPresentationState } from '../../hooks/useDialogPresentationState'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { useResolvedProcessConfig } from './lib/useResolvedProcessConfig'
import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'
import type { TableSortDirection } from '../../components/SortableTableHeader'
import { ParameterTableGrid, parameterTableMinWidth, type ParameterTableBaselineState } from './ParameterTableGrid'
import {
  buildParameterTableRows,
  filterOverriddenRows,
  filterParameterTableRows,
  sortParameterTableRows,
  type ParameterSettingValue,
  type ParameterTableRow,
  type ParameterTableSortKey
} from './lib/parameterTable'
import {
  PARAMETER_TABLE_AVAILABLE_KEYS,
  PARAMETER_TABLE_COLUMNS_STORAGE_KEY,
  parameterTableColumnLabel,
  sanitizeParameterTableColumns
} from './lib/parameterTableColumns'
import type { EditorState } from './lib/editorModel'
import type { PartMember } from './lib/selectionModel'

/**
 * Everything between the dialog's outer width and the grid's scroller: 20px of `ModalDialog`
 * padding either side, plus the dialog's and the bordered `Sheet`'s 1px edges. Measured at 43px;
 * carried as 44 so the grid lands a whole pixel inside rather than on the boundary.
 */
const PARAMETER_TABLE_DIALOG_CHROME = 44

export interface ParameterTableDialogProps {
  open: boolean
  onClose: () => void
  state: EditorState
  /** From the slice controller (`perObjectSettings.value`), not from `EditorState`. */
  objectOverrides: Readonly<Record<string, Readonly<Record<string, ParameterSettingValue>>>>
  globalOverrides: Readonly<Record<string, ParameterSettingValue>>
  /**
   * What the project's process preset resolves FROM. The dialog resolves it itself rather than
   * taking the config, because resolution is a request and the caller (`EditorView`) has no reason
   * to hold the answer: nothing else there reads it.
   */
  processContext: {
    slicerTargetId: string
    processProfileId: string
    sourceFileId: string | null
    resolveConfig?: ProcessConfigResolver
  }
  /** Opens the existing Object settings dialog. */
  onEditObject: (objectId: number, name: string) => void
  /** Opens the existing Part settings dialog. */
  onEditPart: (objectId: number, member: PartMember, name: string) => void
  /**
   * Selects the object in the 3D viewport, as Studio's table does on row select. The dialog closes
   * itself afterwards, since it covers the viewport the selection would otherwise happen behind.
   */
  onSelectObject: (objectId: number) => void
}

export function ParameterTableDialog({
  open, onClose, state, objectOverrides, globalOverrides, processContext,
  onEditObject, onEditPart, onSelectObject
}: ParameterTableDialogProps): JSX.Element {
  // Null while it loads or if it fails. Both are survivable: an OVERRIDDEN cell resolves from the
  // override alone, and those are the rows anyone opened this to find.
  const { config: baseConfig, loading: baseConfigLoading, error: baseConfigError } = useResolvedProcessConfig({
    enabled: open,
    slicerTargetId: processContext.slicerTargetId,
    processProfileId: processContext.processProfileId,
    sourceFileId: processContext.sourceFileId,
    resolveConfig: processContext.resolveConfig
  })

  // No `base` here, deliberately. `base` is a FLOOR, not a default (`resolveDialogPresentation`
  // returns it only when `maximized` is false), so `base: 'maximized'` alongside a maximize toggle
  // gives a button that cannot do anything: every state resolves to maximized and shrinking is a
  // no-op. A dialog that genuinely wants to open maximized passes `maximizedStorageKey: null` and
  // renders no toggle. This one keeps the toggle -- a wide grid is worth shrinking to compare
  // against the viewport behind it -- and gets its default width from the dialog's own `maxWidth`.
  const { presentation, maximized, setMaximized } = useDialogPresentationState({
    maximizedStorageKey: 'printstream.editor.parameterTable.maximized'
  })

  const [columns, setColumns] = useLocalStorageState<string[]>(
    PARAMETER_TABLE_COLUMNS_STORAGE_KEY,
    sanitizeParameterTableColumns(null),
    (raw) => sanitizeParameterTableColumns(JSON.parse(raw) as unknown)
  )
  const [query, setQuery] = useState('')
  const [overriddenOnly, setOverriddenOnly] = useState(false)
  const [sortKey, setSortKey] = useState<ParameterTableSortKey | null>(null)
  const [sortDirection, setSortDirection] = useState<TableSortDirection>('asc')

  const allRows = useMemo(
    () => buildParameterTableRows({ state, objectOverrides, globalOverrides, baseConfig, columns }),
    [state, objectOverrides, globalOverrides, baseConfig, columns]
  )

  const rows = useMemo(() => {
    // Filter before sorting: both filters keep an object row above any surviving volume, and
    // sorting re-groups volumes under their object, so the order is filter -> sort either way.
    let next: readonly ParameterTableRow[] = allRows
    if (overriddenOnly) next = filterOverriddenRows(next)
    if (query.trim()) next = filterParameterTableRows(next, query)
    return sortParameterTableRows(next, sortKey, sortDirection)
  }, [allRows, overriddenOnly, query, sortKey, sortDirection])

  /**
   * Clicking a header sorts by it, and clicking the sorted one reverses.
   *
   * Both setters are called from the HANDLER, reading the current values, rather than nesting one
   * inside the other's updater. A `setState` updater must be pure: React StrictMode double-invokes
   * it in dev (this app mounts inside one), so a direction toggle enqueued from within the key
   * updater ran twice -- asc to desc to asc -- and re-clicking a sorted column did nothing at all.
   * The same replay can happen in production when a concurrent render is discarded. Matches
   * `LogsView`'s `setSort`, which is the sibling implementation of this control.
   */
  const handleSort = useCallback((key: ParameterTableSortKey) => {
    if (key === sortKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(key)
    setSortDirection('asc')
  }, [sortKey, sortDirection])

  const handleEditRow = useCallback((row: ParameterTableRow) => {
    if (row.kind === 'object' || !row.member) onEditObject(row.objectId, row.name)
    else onEditPart(row.objectId, row.member, row.name)
  }, [onEditObject, onEditPart])

  /**
   * Reveal a row's object in the viewport, and CLOSE the table to do it.
   *
   * Selecting without closing was a button with no visible result: this dialog covers the viewport
   * the selection happens in, so the object highlighted, the plate possibly changed, and the user
   * saw none of it -- the same "looks like nothing happened" failure the dialog notes call out for
   * anything that lands behind another dialog. Closing is also what the gesture means: the row is
   * being used to FIND the object, and the table is one button away again.
   */
  const handleSelectRow = useCallback((row: ParameterTableRow) => {
    onSelectObject(row.objectId)
    onClose()
  }, [onSelectObject, onClose])

  const toggleColumn = useCallback((key: string) => {
    setColumns(columns.includes(key) ? columns.filter((entry) => entry !== key) : [...columns, key])
  }, [columns, setColumns])

  /**
   * What a cell may claim when it resolves to nothing.
   *
   * Without this, every INHERITED cell rendered "Not set by this project or its preset" for the
   * whole resolve round trip, and permanently if the resolve failed -- a confident statement about
   * the project that is merely not known yet. The rows are still worth showing meanwhile, because
   * an overridden cell resolves from its override alone and those are what anyone opened this for.
   */
  const baselineState: ParameterTableBaselineState = baseConfig
    ? 'ready'
    : baseConfigError ? 'failed' : baseConfigLoading ? 'loading' : 'ready'

  const objectCount = allRows.filter((row) => row.kind === 'object').length
  const partCount = allRows.length - objectCount
  // Two counts, because they answer two questions and conflating them is what went wrong twice.
  // `overriddenCount` is how many rows CARRY an override, which is what the subtitle claims; it is
  // counted over every row, objects and parts alike, so the subtitle has to name the parts too (an
  // object total against an all-row count let the second number exceed the first). What the
  // "Overridden only" FILTER reveals is a different, larger set: `filterOverriddenRows` keeps an
  // object row whenever any of its parts qualifies, so the checkbox is enabled on that count
  // instead, or it would be disabled while the filter still had rows to show.
  const overriddenCount = allRows.filter((row) => row.overrideCount > 0).length
  const overriddenFilterRowCount = filterOverriddenRows(allRows).length
  const filtersActive = overriddenOnly || query.trim().length > 0

  return (
    <BackAwareModal open={open} onClose={onClose}>
      {/* Wide enough for the grid the CURRENT columns need, so the scroller appears only when the
          viewport is the constraint. A flat 1200 here left the default five columns 13px short and
          the grid scrolled horizontally in its opening state, forever. The theme clamps every
          ModalDialog to the viewport, so this is a ceiling rather than a promise; `maximized`
          strips it outright. */}
      <ScrollableModalDialog
        presentation={presentation}
        sx={{ maxWidth: parameterTableMinWidth(columns.length) + PARAMETER_TABLE_DIALOG_CHROME, width: '100%' }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>Parameter table</Typography>
          <MaximizeDialogButton active={maximized} onToggle={setMaximized} />
        </Stack>
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          {objectCount === 1 ? '1 object' : `${objectCount} objects`}
          {partCount > 0 && (partCount === 1 ? ', 1 part' : `, ${partCount} parts`)}
          {overriddenCount > 0 && `, ${overriddenCount} with their own settings`}
        </Typography>

        <Stack
          direction="row"
          spacing={1}
          sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search objects and parts"
            startDecorator={<SearchRoundedIcon />}
            endDecorator={query
              ? (
                <IconButton size="sm" variant="plain" color="neutral" aria-label="Clear search" onClick={() => setQuery('')}>
                  <CloseRoundedIcon />
                </IconButton>
              )
              : null}
            sx={{ flex: '1 1 220px', minWidth: 0 }}
          />
          <Checkbox
            size="sm"
            label="Overridden only"
            checked={overriddenOnly}
            onChange={(event) => setOverriddenOnly(event.target.checked)}
            // Matches the settings dialog's "Changed only": offered but inert when there is
            // nothing to narrow to, rather than hidden, so the control does not come and go.
            disabled={overriddenFilterRowCount === 0 && !overriddenOnly}
          />
          <ToolbarMenuButton
            icon={<ViewColumnRoundedIcon />}
            label={`Columns (${columns.length})`}
            ariaLabel="Choose columns"
            variant="panel"
          >
            {() => (
              <Stack spacing={0.75} sx={{ minWidth: 0, maxHeight: 'min(50vh, 420px)', overflowY: 'auto' }}>
                {PARAMETER_TABLE_AVAILABLE_KEYS.map((key) => (
                  <Checkbox
                    key={key}
                    size="sm"
                    label={parameterTableColumnLabel(key)}
                    checked={columns.includes(key)}
                    onChange={() => toggleColumn(key)}
                  />
                ))}
              </Stack>
            )}
          </ToolbarMenuButton>
        </Stack>

        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          {baseConfigError && (
            // The grid stays usable without the preset (overrides still resolve), so this explains
            // the gap rather than replacing the table with an error.
            <Alert color="danger" variant="soft" size="sm" sx={{ mb: 1.5 }}>
              {`Inherited values are unavailable: ${baseConfigError}`}
            </Alert>
          )}
          {rows.length === 0
            ? (
              <EmptyState
                icon={<TableRowsRoundedIcon />}
                title={filtersActive ? 'Nothing matches' : 'No objects yet'}
                description={filtersActive
                  ? 'Try another search or filter.'
                  : 'Add a model to view its settings.'}
                {...(filtersActive
                  ? {
                    action: (
                      <Button
                        size="sm"
                        variant="soft"
                        onClick={() => { setQuery(''); setOverriddenOnly(false) }}
                      >
                        Clear filters
                      </Button>
                    )
                  }
                  : {})}
              />
            )
            : (
              <ParameterTableGrid
                rows={rows}
                columns={columns}
                baselineState={baselineState}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={handleSort}
                onEditRow={handleEditRow}
                onSelectRow={handleSelectRow}
              />
            )}
        </ScrollableDialogBody>

        <Divider />
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

export default ParameterTableDialog
