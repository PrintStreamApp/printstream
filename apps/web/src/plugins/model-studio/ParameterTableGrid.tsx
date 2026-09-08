/**
 * How the parameter table's rows are drawn: a real table from `sm` up, stacked cards on a phone.
 *
 * Presentation only. It decides nothing about what a row means or what a cell resolves to (that is
 * `lib/parameterTable.ts`) and it writes nothing (every action is a callback the dialog routes to
 * the existing settings dialogs).
 *
 * Three rendering rules that are conventions here rather than choices:
 *
 * - **A wide table gets a card fallback, never hidden columns.** No view in this app hides a column
 *   at a breakpoint; the sanctioned answers are a card fallback or scroll-with-min-width, and at
 *   375px a five-column settings grid is unreadable either way. `LogsView` is the pattern copied.
 * - **The card fallback is at PARITY with the table**, not a reduced version of it. Same actions,
 *   same chips, same memoisation. It shipped without the select action, without the skipped chip,
 *   and showing the copy badge on part rows where the table hides it -- so the same project read
 *   differently depending on the width of the window, and one row action was desktop-only. This
 *   plugin's guide is explicit that mobile is not a scaled-down afterthought.
 * - **The min width is computed from the column count**, as `RolePermissionsMatrix` does, so adding
 *   a column widens the scroller instead of squeezing every other column narrower.
 */
import { memo } from 'react'
import { Box, Chip, IconButton, Sheet, Stack, Table, Tooltip, Typography } from '@mui/joy'
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded'
import { processSettingsCatalog } from '@printstream/shared'
import { SettingsTuneButton } from '../../components/SettingsTuneButton'
import { SortableTableHeader, type TableSortDirection } from '../../components/SortableTableHeader'
import { formatSettingValueForDisplay } from '../../components/settings/settingValueDisplay'
import { parameterTableColumnLabel } from './lib/parameterTableColumns'
import { isUnsetCellValue } from './lib/parameterTable'
import type { ParameterTableCell, ParameterTableRow, ParameterTableSortKey } from './lib/parameterTable'

/** Fixed leading columns, then one per chosen setting. Widths feed the scroller's min width. */
const NAME_COLUMN_WIDTH = 260
const PLATE_COLUMN_WIDTH = 96
const SETTING_COLUMN_WIDTH = 150
const ACTIONS_COLUMN_WIDTH = 64

/**
 * How wide the grid needs to be for `settingColumns` chosen settings.
 *
 * EXPORTED because the dialog has to size itself from the same arithmetic. Left to a literal on
 * each side they disagreed silently: the dialog was 1200px wide, the default five columns need
 * 1170, and the 43px of chrome between them (the dialog's 20px padding either side plus the dialog
 * and Sheet borders) left the scroller at 1157. So the table overflowed by 13px and the grid
 * carried a horizontal scrollbar in its DEFAULT state, scrolling by a sliver, on every screen.
 *
 * The scroller is still the right answer for a genuinely wide selection; it just must not be the
 * answer for the set the dialog opens with.
 */
export function parameterTableMinWidth(settingColumns: number): number {
  return NAME_COLUMN_WIDTH + PLATE_COLUMN_WIDTH + ACTIONS_COLUMN_WIDTH
    + settingColumns * SETTING_COLUMN_WIDTH
}

/**
 * Whether the inherited baseline (the resolved process preset) is known yet.
 *
 * A cell that resolves to nothing means something different in each state, and saying the wrong one
 * is a confident lie about the project: `ready` genuinely has no value, `loading` does not know yet,
 * and `failed` could not find out. Only `ready` may claim "not set".
 */
export type ParameterTableBaselineState = 'ready' | 'loading' | 'failed'

export interface ParameterTableGridProps {
  rows: readonly ParameterTableRow[]
  columns: readonly string[]
  /** What an empty cell is allowed to claim. See {@link ParameterTableBaselineState}. */
  baselineState: ParameterTableBaselineState
  sortKey: ParameterTableSortKey | null
  sortDirection: TableSortDirection
  onSort: (key: ParameterTableSortKey) => void
  /** Open the settings dialog for this row. The dialog owns which of the two it is. */
  onEditRow: (row: ParameterTableRow) => void
  /** Reveal the row's object in the 3D viewport, as BambuStudio's table does on row select. */
  onSelectRow: (row: ParameterTableRow) => void
}

/** Display text for a resolved cell, or null when it has no value to show. */
function cellText(key: string, cell: ParameterTableCell | undefined): string | null {
  // The SAME predicate the sort uses, which is the whole reason it is exported: it counts an empty
  // string and an empty vector as unset, and testing only `null` here made such a cell sort to the
  // bottom as "no answer" while rendering as a value (a bare unit, for any option with a sidetext)
  // instead of the em-dash and the "Not set by this project or its preset" tooltip its neighbours get.
  // The `== null` ahead of it is narrowing for the compiler, not a second opinion: the predicate
  // answers true for a nullish value too.
  const value = cell?.value
  if (value == null || isUnsetCellValue(value)) return null
  const option = processSettingsCatalog.options[key]
  // A per-object override is normally scalar, but the type permits a vector (a per-extruder value
  // carried through unchanged). Join rather than dropping it: showing the first element would
  // report a value the object does not actually have.
  //
  // Blank elements are dropped and each survivor is FORMATTED, which the raw join did neither of. A
  // two-extruder machine with only extruder 1 set rendered "0.2, " -- a trailing separator with
  // nothing after it, beside cells showing the em-dash -- and the same layer height read "0.2 mm"
  // when scalar and "0.2" when per-extruder. `isUnsetCellValue` above has already answered for the
  // all-blank case, so what reaches here has at least one real element.
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== '')
      .map((entry) => formatSettingValueForDisplay(option, entry, { sentenceCase: true }))
      .join(', ')
  }
  return formatSettingValueForDisplay(option, value, { sentenceCase: true })
}

/** What an empty cell says, which depends entirely on whether the baseline is known. */
const EMPTY_CELL_TOOLTIP: Record<ParameterTableBaselineState, string> = {
  ready: 'Not set by this project or its preset',
  loading: 'Loading the values inherited from the preset',
  failed: 'The preset could not be loaded, so inherited values are unknown'
}

/** One cell's value with the emphasis that says where it came from. */
function CellValue({ settingKey, cell, baselineState }: {
  settingKey: string
  cell: ParameterTableCell | undefined
  baselineState: ParameterTableBaselineState
}): JSX.Element {
  const text = cellText(settingKey, cell)
  if (text === null) {
    return (
      <Tooltip title={EMPTY_CELL_TOOLTIP[baselineState]} size="sm">
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          {baselineState === 'ready' ? <>&mdash;</> : '…'}
        </Typography>
      </Tooltip>
    )
  }
  if (!cell?.overridden) {
    // Inherited values are deliberately quiet: the whole point of the grid is that the overridden
    // ones stand out, and equal weight everywhere is the same as no weight anywhere.
    return <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>{text}</Typography>
  }
  return (
    <Tooltip
      size="sm"
      title={cell.redundant
        ? 'Set on this row, but the same as the value it would inherit. It will not follow a change to the preset.'
        : 'Set on this row'}
    >
      <Typography
        level="body-sm"
        sx={{ fontWeight: 'lg', color: cell.redundant ? 'warning.plainColor' : 'primary.plainColor' }}
      >
        {text}
      </Typography>
    </Tooltip>
  )
}

/**
 * Plate numbers an object sits on. An object placed on several genuinely belongs to all of them.
 *
 * Never empty: a row exists only because an instance was found on a plate, and that plate's index
 * is recorded as the row is created. No empty-case placeholder, because a branch that cannot run is
 * a branch nobody can check.
 */
function plateText(row: ParameterTableRow): string {
  return row.plateIndexes.join(', ')
}

function rowTitle(row: ParameterTableRow): string {
  return row.kind === 'object' ? `Object settings for ${row.name}` : `Part settings for ${row.name}`
}

/** The copy badge, shown on object rows only: a volume is not placed, its object is. */
function CopiesChip({ row }: { row: ParameterTableRow }): JSX.Element | null {
  if (row.kind !== 'object' || row.copies < 2) return null
  return (
    <Tooltip size="sm" title={`${row.copies} linked copies share these settings`}>
      <Chip size="sm" variant="soft" color="neutral">{`×${row.copies}`}</Chip>
    </Tooltip>
  )
}

/** Skipped state, three-valued because an object's copies can disagree (see `printability`). */
function PrintabilityChip({ row }: { row: ParameterTableRow }): JSX.Element | null {
  if (row.kind !== 'object' || row.printability === 'all') return null
  const skipped = row.printability === 'none'
  return (
    <Tooltip size="sm" title={skipped ? 'This object will not print' : 'Some copies of this object will not print'}>
      <Chip size="sm" variant="soft" color="neutral">{skipped ? 'Skipped' : 'Some skipped'}</Chip>
    </Tooltip>
  )
}

/** The two row actions, identical on both layouts so neither width loses one. */
function RowActions({ row, onEditRow, onSelectRow }: {
  row: ParameterTableRow
  onEditRow: (row: ParameterTableRow) => void
  onSelectRow: (row: ParameterTableRow) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.25} sx={{ justifyContent: 'flex-end' }}>
      {/* Says "show", not "select": it closes the table, because the dialog covers the viewport
          the selection happens in and a selection nobody can see reads as a dead button. */}
      <Tooltip size="sm" title="Show in the viewport">
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={`Show ${row.name} in the viewport`}
          onClick={() => onSelectRow(row)}
        >
          <ViewInArRoundedIcon />
        </IconButton>
      </Tooltip>
      <SettingsTuneButton
        changedCount={row.overrideCount}
        title={rowTitle(row)}
        ariaLabel={rowTitle(row)}
        onClick={() => onEditRow(row)}
      />
    </Stack>
  )
}

interface RowProps {
  row: ParameterTableRow
  columns: readonly string[]
  baselineState: ParameterTableBaselineState
  onEditRow: (row: ParameterTableRow) => void
  onSelectRow: (row: ParameterTableRow) => void
}

/**
 * One table row, memoised.
 *
 * Not an optimisation to revisit later: this plugin's recurring performance bug is a list of rows
 * carrying Joy `Tooltip`/`IconButton`/`Badge` furniture re-rendering wholesale, and it is what made
 * `ObjectList` ~82% of a keystroke before it was memoised. A row here carries several tooltips and
 * a badge, and a SORT changes only the ORDER: the rows themselves are identical objects, so
 * memoised React can reorder the DOM nodes instead of rebuilding 121 rows of Joy components.
 *
 * The unmemoised cost was measured, on a real 111-object / 121-row project in a DEV build: ~600ms
 * per sort click and 67-233ms per keystroke in the search box. The post-memo figure is NOT recorded
 * here because it has not been measured on the same project -- if you are here to tune this, measure
 * both ends rather than trusting the reasoning, which is exactly what this plugin's notes say has
 * gone wrong before.
 *
 * The contract that makes it work: every prop must be stable. `row` objects change identity only
 * when the underlying data does (they come from a `useMemo`), `columns` is state, `baselineState` is
 * a string, and both callbacks are `useCallback`d in the dialog. One inline arrow at the call site
 * defeats this silently, exactly as it does for `ObjectList`.
 */
const ParameterTableBodyRow = memo(function ParameterTableBodyRow({
  row, columns, baselineState, onEditRow, onSelectRow
}: RowProps) {
  return (
    <tr>
      <th scope="row" style={{ paddingLeft: row.kind === 'part' ? 32 : undefined }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography
            level="body-sm"
            noWrap
            sx={{ minWidth: 0, fontWeight: row.kind === 'object' ? 'lg' : undefined }}
          >
            {row.name}
          </Typography>
          <CopiesChip row={row} />
          <PrintabilityChip row={row} />
        </Stack>
      </th>
      <td>
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>{plateText(row)}</Typography>
      </td>
      {columns.map((key) => (
        <td key={key}>
          <CellValue settingKey={key} cell={row.cells[key]} baselineState={baselineState} />
        </td>
      ))}
      <td><RowActions row={row} onEditRow={onEditRow} onSelectRow={onSelectRow} /></td>
    </tr>
  )
})

/** The phone layout of the same row. Memoised on the same rule and for the same reason. */
const ParameterTableCardRow = memo(function ParameterTableCardRow({
  row, columns, baselineState, onEditRow, onSelectRow
}: RowProps) {
  return (
    <Stack spacing={0.75} sx={{ p: 1.25, pl: row.kind === 'part' ? 3 : 1.25 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <Typography
          level="body-sm"
          noWrap
          sx={{ flex: 1, minWidth: 0, fontWeight: row.kind === 'object' ? 'lg' : undefined }}
        >
          {row.name}
        </Typography>
        <CopiesChip row={row} />
        <PrintabilityChip row={row} />
        <RowActions row={row} onEditRow={onEditRow} onSelectRow={onSelectRow} />
      </Stack>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Stack sx={{ minWidth: 90 }}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>Plate</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>{plateText(row)}</Typography>
        </Stack>
        {columns.map((key) => (
          <Stack key={key} sx={{ minWidth: 120 }}>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {parameterTableColumnLabel(key)}
            </Typography>
            <CellValue settingKey={key} cell={row.cells[key]} baselineState={baselineState} />
          </Stack>
        ))}
      </Stack>
    </Stack>
  )
})

export function ParameterTableGrid({
  rows, columns, baselineState, sortKey, sortDirection, onSort, onEditRow, onSelectRow
}: ParameterTableGridProps): JSX.Element {
  const minWidth = parameterTableMinWidth(columns.length)

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'hidden' }}>
      {/* Phone: one card per row. A five-column grid cannot be read at 375px, and this app's
          convention is a card fallback rather than dropping columns. */}
      <Box sx={{ display: { xs: 'block', sm: 'none' } }}>
        <Stack divider={<Box sx={{ borderTop: '1px solid', borderColor: 'divider' }} />}>
          {rows.map((row) => (
            <ParameterTableCardRow
              key={row.key}
              row={row}
              columns={columns}
              baselineState={baselineState}
              onEditRow={onEditRow}
              onSelectRow={onSelectRow}
            />
          ))}
        </Stack>
      </Box>

      <Box sx={{ display: { xs: 'none', sm: 'block' }, overflowX: 'auto' }}>
        <Table
          size="sm"
          borderAxis="xBetween"
          stripe="odd"
          stickyHeader
          hoverRow
          sx={{ minWidth }}
        >
          <thead>
            <tr>
              <th style={{ width: NAME_COLUMN_WIDTH }}>
                <SortableTableHeader
                  label="Name"
                  active={sortKey === 'name'}
                  direction={sortDirection}
                  onClick={() => onSort('name')}
                />
              </th>
              <th style={{ width: PLATE_COLUMN_WIDTH }}>
                <SortableTableHeader
                  label="Plate"
                  active={sortKey === 'plate'}
                  direction={sortDirection}
                  onClick={() => onSort('plate')}
                />
              </th>
              {columns.map((key) => (
                <th key={key} style={{ width: SETTING_COLUMN_WIDTH }}>
                  <SortableTableHeader
                    label={parameterTableColumnLabel(key)}
                    active={sortKey === key}
                    direction={sortDirection}
                    onClick={() => onSort(key)}
                  />
                </th>
              ))}
              {/* An icon-only edge column needs ~64px, not 48: the theme's outer gutter eats the
                  difference (see the table density block in `theme/buildTheme.ts`). */}
              <th aria-label="Actions" style={{ width: ACTIONS_COLUMN_WIDTH }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ParameterTableBodyRow
                key={row.key}
                row={row}
                columns={columns}
                baselineState={baselineState}
                onEditRow={onEditRow}
                onSelectRow={onSelectRow}
              />
            ))}
          </tbody>
        </Table>
      </Box>
    </Sheet>
  )
}
