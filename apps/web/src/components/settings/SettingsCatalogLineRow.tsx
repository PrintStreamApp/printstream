/**
 * One settings line: the label column, its value controls, and each control's reset.
 *
 * Catalog-agnostic — everything that varies between the process, filament and machine dialogs
 * arrives through {@link SettingsCatalogAdapter}. A line may render several controls for two
 * different reasons, and they look the same on screen: several KEYS on one line (BambuStudio's
 * "Nozzle: initial layer / other layers") or several COLUMNS of one key (a machine vector, one per
 * extruder). Both flow through `columnsFor`, so the "name each control when there is more than one"
 * rule is applied once over the total.
 *
 * Counterpart: `SettingsCatalogDialog.tsx`, which owns the pages these lines sit on.
 */
import { Box, FormControl, FormLabel, IconButton, Stack, Tooltip } from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import type { ProcessSettingsCatalog } from '@printstream/shared'
import { SettingValueField, type SettingFilamentChoice } from './SettingValueField'
import { isFieldChanged, type SettingsCatalogAdapter } from './settingsCatalogAdapter'

export interface SettingsCatalogLineRowProps {
  catalog: ProcessSettingsCatalog
  /** The catalog line's own label, when it names the row better than the first option does. */
  lineLabel?: string
  /** The line's keys, already filtered to those the dialog is showing. */
  keys: string[]
  /** The line is a monospace editor (G-code) — spans the row and renders as code. */
  code?: boolean
  /** The line spans the row without being code (BambuStudio's Notes fields). */
  fullWidth?: boolean
  adapter: SettingsCatalogAdapter
  /** Project materials for filament-index settings; see {@link SettingValueField}. */
  filamentChoices?: SettingFilamentChoice[]
}

export function SettingsCatalogLineRow(props: SettingsCatalogLineRowProps): JSX.Element | null {
  const { catalog, lineLabel, keys, code, fullWidth, adapter, filamentChoices } = props
  if (keys.length === 0) return null

  const columns = keys.flatMap((key) => adapter.columnsFor(key))
  if (columns.length === 0) return null

  const firstKey = keys[0] ?? ''
  const firstOption = catalog.options[firstKey]
  const label = lineLabel ?? firstOption?.label ?? firstKey

  // One rule for all three dialogs, and the same one `SettingValueField` applies per control: an
  // edit made in this SESSION is amber+bold, an override the preset already carried is bold+italic
  // (noticeable without reading as an alert about something wrong), and a per-object pin that
  // matches its inherited value gets full contrast plus the marker dot, since it has no value
  // difference to show. The process and filament dialogs had drifted to different answers here.
  //
  // `isModified` earns bold without amber on its own: that is a change a 3MF BAKED IN, which this
  // session did not make and so must not be coloured like an unsaved edit, but which is still
  // counted, filterable and resettable — so the row has to look like something.
  const lineUnsaved = keys.some((key) => adapter.isUnsaved(key))
  const lineModified = keys.some((key) => adapter.isModified(key))
  const linePresetOverride = keys.some((key) => adapter.isPresetOverride(key))
  const marker = adapter.lineMarker?.(keys) ?? null
  const labelColor = lineUnsaved ? 'warning.plainColor' : marker ? 'text.primary' : undefined

  // Full-width lines take the label above and the whole row: the G-code editors and Notes.
  const spansRow = Boolean(code || fullWidth)
  // A Joy FormControl may contain exactly ONE control, and it labels that control. A row with
  // several controls is several inputs each labelling itself via `showOwnLabel`, so wrapping those
  // in a FormControl is both a Joy error (logged on every render) and a false label association.
  // Cast: both accept children and no required props, but a union of two component types is not
  // callable as a JSX tag.
  const RowRoot = (columns.length === 1 ? FormControl : Box) as typeof Box

  return (
    <RowRoot>
      <Stack
        direction={spansRow ? 'column' : { xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={spansRow ? 'stretch' : { sm: 'center' }}
      >
        <Box sx={{ minWidth: spansRow ? undefined : { sm: 220 }, flexShrink: 0 }}>
          <FormLabel sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            color: labelColor,
            fontWeight: lineUnsaved || lineModified || linePresetOverride || marker ? 'xl' : undefined,
            fontStyle: linePresetOverride && !lineUnsaved && !lineModified ? 'italic' : undefined
          }}>
            {marker && (
              <Tooltip title={marker.tooltip} variant="soft">
                <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.solidBg', flexShrink: 0 }} />
              </Tooltip>
            )}
            {label}
            {firstOption?.tooltip && (
              <Tooltip title={firstOption.tooltip} variant="soft" sx={{ maxWidth: 320 }}>
                <Box component="span" sx={{ display: 'inline-flex', fontSize: 16, opacity: 0.6 }}>
                  <InfoOutlinedIcon fontSize="inherit" />
                </Box>
              </Tooltip>
            )}
          </FormLabel>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            flex: 1,
            flexWrap: 'wrap',
            justifyContent: spansRow ? 'stretch' : { sm: 'flex-end' },
            width: spansRow ? '100%' : undefined
          }}
        >
          {columns.map((column) => {
            const option = catalog.options[column.settingKey]
            if (!option) return null
            return (
              <Stack
                key={column.id}
                direction="row"
                spacing={0.25}
                alignItems="center"
                sx={spansRow ? { flex: 1, minWidth: 0 } : undefined}
              >
                {column.prefix}
                <SettingValueField
                  settingKey={column.settingKey}
                  option={option}
                  value={column.value}
                  enabled={column.enabled ?? true}
                  enumRestriction={column.enumRestriction}
                  showOwnLabel={columns.length > 1}
                  ownLabel={column.label}
                  modified={adapter.isPresetOverride(column.settingKey)}
                  unsaved={isFieldChanged(adapter, column.settingKey)}
                  mixed={column.mixed}
                  original={adapter.originalOf(column.settingKey)}
                  filamentChoices={filamentChoices}
                  onScalarChange={(_key, value) => column.onChange(value)}
                  isCode={code}
                />
                {adapter.canReset(column.settingKey) && (
                  <Tooltip title="Reset to preset default" variant="soft">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="warning"
                      aria-label={`Reset ${option.label} to default`}
                      onClick={() => adapter.onReset(column.settingKey)}
                      sx={{ '--IconButton-size': '1.75rem' }}
                    >
                      <Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}>
                        <RestartAltRoundedIcon fontSize="inherit" />
                      </Box>
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            )
          })}
        </Stack>
      </Stack>
    </RowRoot>
  )
}
