import { Box, Card, CardContent, Chip, Stack, Tooltip, Typography, type ColorPaletteProp } from '@mui/joy'
import type { ReactNode } from 'react'
import type { PrintJob } from '@printstream/shared'
import { useLocation, useNavigate } from 'react-router-dom'
import { bambuMaterialFromPresetName, readableTextColor } from '../data/bambuColors'
import { brandFromPresetName } from '../data/bambuFilamentPresets'
import { resolveProjectFilamentColorName } from '../lib/filamentColor'
import { formatJobDispatchDetails } from '../lib/jobHistory'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { formatDateTime, formatSecondsDuration } from '../lib/time'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { JobHistoryMedia } from './JobHistoryMedia'

export function PrintJobHistoryCard({
  job,
  action,
  showPrinterLink = true,
  mediaSize = 'default',
  cardVariant = 'outlined'
}: {
  job: PrintJob
  action?: ReactNode
  showPrinterLink?: boolean
  mediaSize?: 'default' | 'compact'
  cardVariant?: 'outlined' | 'soft' | 'plain' | 'solid'
}) {
  return (
    <Card variant={cardVariant} sx={{ height: '100%', width: '100%', minWidth: 0 }}>
      <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box
          sx={{
            minWidth: 0,
            flex: 1,
            display: 'flow-root'
          }}
        >
          <Box
            sx={{
              display: { xs: 'none', sm: 'flex' },
              float: 'right',
              ml: { sm: 1.25 },
              mb: 1,
              justifyContent: 'flex-end',
              maxWidth: '100%'
            }}
          >
            <JobHistoryMedia job={job} size={mediaSize} />
          </Box>
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <Stack spacing={0.75} sx={{ minWidth: 0 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, flexWrap: 'wrap' }}>
                <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere', textWrap: 'balance' }}>
                  {formatLibraryFileName(job.fileName || job.jobName || 'Untitled')}
                </Typography>
                <Chip size="sm" variant="soft" color={historyResultColor(job.result)} sx={{ flexShrink: 0 }}>
                  {historyResultLabel(job.result)}
                </Chip>
              </Stack>
              <Typography level="body-sm" textColor="text.tertiary" sx={{ textWrap: 'pretty', overflowWrap: 'anywhere' }}>
                {showPrinterLink ? (
                  <>
                    <PrinterRouteButton printerId={job.printerId} label={job.printerName} /> - {formatJobDispatchDetails(job)}
                  </>
                ) : formatJobDispatchDetails(job)}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {formatDateTime(job.startedAt)}{job.durationSeconds != null ? ` - ${formatSecondsDuration(job.durationSeconds)}` : ''}
              </Typography>
              <ProjectFilamentChipRow chips={job.projectFilamentChips} />
            </Stack>
            <Box sx={{ display: { xs: 'flex', sm: 'none' }, maxWidth: '100%' }}>
              <JobHistoryMedia job={job} size={mediaSize} />
            </Box>
            {job.activity.length > 0 ? (
              <Stack spacing={0.5} sx={{ pt: 0.25, minWidth: 0 }}>
                {job.activity.slice(0, 3).map((entry) => (
                  <Typography key={entry.id} level="body-xs" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {formatActivityActor(entry)}: {entry.summary} {formatDateTime(entry.timestamp)}
                  </Typography>
                ))}
              </Stack>
            ) : null}
          </Stack>
        </Box>
        {action ? (
          <Box
            sx={{
              pt: { xs: 0.25, sm: 0.5 },
              display: 'flex',
              justifyContent: 'flex-start',
              mt: 'auto'
            }}
          >
            {action}
          </Box>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function ProjectFilamentChipRow({
  chips,
  compact = false
}: {
  chips: PrintJob['projectFilamentChips']
  compact?: boolean
}) {
  if (chips.length === 0) return null

  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ minWidth: 0, flexWrap: 'wrap' }}>
      {chips.map((chip, index) => {
        const display = summarizeProjectFilamentLabel(chip.label)
        return (
          <Tooltip
            key={`${chip.label}-${chip.color ?? 'none'}-${index}`}
            variant="outlined"
            placement="top"
            arrow
            title={<FilamentTooltipBody label={chip.label} color={chip.color} />}
            sx={{ maxWidth: 280, p: 0 }}
          >
            <Chip
              size="sm"
              variant="soft"
              color="neutral"
              sx={{
                '--Chip-minHeight': compact ? '16px' : '18px',
                fontSize: compact ? '10px' : '11px',
                maxWidth: '100%',
                backgroundColor: 'var(--joy-palette-neutral-softBg)',
                color: 'var(--joy-palette-neutral-softColor)',
                border: '1px solid rgba(196, 208, 221, 0.18)',
                '& .MuiChip-label': {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem'
                }
              }}
            >
              <Box
                component="span"
                sx={{
                  width: compact ? 6 : 7,
                  height: compact ? 6 : 7,
                  borderRadius: '999px',
                  flexShrink: 0,
                  backgroundColor: chip.color ?? 'var(--joy-palette-neutral-500)',
                  boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.14)'
                }}
              />
              <span>{display.shortLabel}</span>
            </Chip>
          </Tooltip>
        )
      })}
    </Stack>
  )
}

export function PrinterRouteButton({
  printerId,
  label,
  onNavigate
}: {
  printerId: string
  label: string
  onNavigate?: (printerId: string) => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const tenantSlug = parseWorkspacePathname(location.pathname).tenantSlug

  return (
    <Box
      component="button"
      type="button"
      onClick={() => {
        if (onNavigate) {
          onNavigate(printerId)
          return
        }
        if (tenantSlug) navigate(buildTenantWorkspacePath(tenantSlug, `/printers/${printerId}`))
      }}
      sx={{
        p: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        lineHeight: 'inherit',
        textAlign: 'inherit',
        cursor: 'pointer',
        verticalAlign: 'baseline',
        '&:hover, &:focus-visible': {
          color: 'var(--joy-palette-primary-200)'
        },
        '&:focus-visible': {
          outline: '2px solid var(--joy-palette-focusVisible)',
          outlineOffset: '2px',
          borderRadius: 'var(--joy-radius-xs)'
        }
      }}
    >
      {label}
    </Box>
  )
}

function historyResultColor(result: PrintJob['result']): ColorPaletteProp {
  switch (result) {
    case 'success':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'warning'
    case 'unknown':
      return 'neutral'
  }
}

function historyResultLabel(result: PrintJob['result']): string {
  switch (result) {
    case 'success':
      return 'Success'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'unknown':
      return 'Unknown'
  }
}

function formatActivityActor(entry: PrintJob['activity'][number]): string {
  return entry.actorLabel?.trim() || entry.actorUserId || entry.actorServiceAccountId || 'Someone'
}

function FilamentTooltipBody({ label, color }: { label: string; color: string | null }) {
  // Bambu marketing names only when the filament's own name is Bambu-branded —
  // a bare hex must not resolve to another family's marketing colour.
  const bambuMaterial = brandFromPresetName(label.trim()) === 'Bambu' ? bambuMaterialFromPresetName(label) : null
  const headerBg = color ?? 'var(--joy-palette-neutral-800)'
  const headerFg = color ? readableTextColor(color) : 'var(--joy-palette-text-primary)'
  const colorLabel = resolveProjectFilamentColorName({ color, filamentName: label, filamentType: null })
    ?? (color ? 'Custom colour' : 'No colour')
  const materialLabel = bambuMaterial ? `Bambu ${bambuMaterial}` : 'Project filament'
  const basicType = extractBasicFilamentType(label, bambuMaterial)

  return (
    <Stack
      sx={{
        minWidth: 220,
        maxWidth: 280,
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          backgroundColor: headerBg,
          color: headerFg,
          borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
        }}
      >
        <Typography
          level="title-sm"
          sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }}
          noWrap
        >
          {colorLabel}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.85, flexShrink: 0 }}>
          Filament
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ px: 1.25, py: 1 }}>
        <Typography level="body-sm">{label}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">{materialLabel}</Typography>
        {basicType && (
          <Typography level="body-xs" textColor="text.tertiary">Type: {basicType}</Typography>
        )}
      </Stack>
    </Stack>
  )
}

function extractBasicFilamentType(label: string, material: string | null): string | null {
  const haystacks = [material, label]
  const filamentTypes = ['PETG', 'PLA', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PP', 'PET', 'PPS', 'PEEK']

  for (const haystack of haystacks) {
    if (!haystack) continue
    const upper = haystack.toUpperCase()
    for (const filamentType of filamentTypes) {
      const pattern = new RegExp(`(^|[^A-Z])${filamentType}([^A-Z]|$)`)
      if (pattern.test(upper)) return filamentType
    }
  }

  return null
}


function summarizeProjectFilamentLabel(label: string): { shortLabel: string; truncated: boolean } {
  const separators = [' - ', ' · ', ' / ', ' | ', ' @', ' (']
  let cutoff = -1
  for (const separator of separators) {
    const index = label.indexOf(separator)
    if (index <= 0) continue
    if (cutoff === -1 || index < cutoff) cutoff = index
  }
  if (cutoff === -1) return { shortLabel: label, truncated: false }
  return { shortLabel: `${label.slice(0, cutoff).trim()}...`, truncated: true }
}