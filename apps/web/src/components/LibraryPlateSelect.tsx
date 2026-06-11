import { useEffect, useState } from 'react'
import { Box, Button, FormControl, FormLabel, IconButton, Option, Select, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded'
import type { ThreeMfIndex } from '@printstream/shared'
import { buildApiUrl } from '../lib/apiUrl'
import { getSceneThumbnailProvider } from '../lib/stlThumbnailRegistry'
import { OverflowTooltipText } from './OverflowTooltipText'
import { SquareMediaFrame } from './SquareMediaFrame'

export function LibraryPlateSelect({
  fileId,
  resourceBasePath,
  thumbnailVersion,
  plates,
  value,
  onChange,
  label = 'Plate'
}: {
  fileId: string
  resourceBasePath?: string
  /**
   * Cache-buster for thumbnail URLs (typically the file's `uploadedAt`).
   * Overwrites keep the file id, so without this browsers keep serving the
   * previous content's plate images from cache.
   */
  thumbnailVersion?: string | null
  plates: ThreeMfIndex['plates']
  value: number
  onChange: (value: number) => void
  label?: string | null
}) {
  return (
    <FormControl sx={{ minWidth: 0, width: '100%' }}>
      {label ? <FormLabel>{label}</FormLabel> : null}
      <Select
        value={value}
        onChange={(_event, nextValue) => nextValue && onChange(nextValue)}
        sx={{ '--Select-minHeight': '64px', alignItems: 'stretch', minWidth: 0, width: '100%' }}
        slotProps={{
          button: { sx: { py: 0.5, textAlign: 'left', justifyContent: 'flex-start', minWidth: 0 } },
          listbox: { sx: { minWidth: 0 } }
        }}
        renderValue={(option) => {
          if (!option) return null
          const plate = plates.find((entry) => entry.index === option.value)
          return (
            <LibraryPlatePreview
              fileId={fileId}
              resourceBasePath={resourceBasePath}
              thumbnailVersion={thumbnailVersion}
              plate={plate}
              size={48}
              subtitleFallback={formatPlateFallback(plate)}
            />
          )
        }}
      >
        {plates.map((plate) => (
          <Option key={plate.index} value={plate.index} sx={{ minWidth: 0, '& > *': { minWidth: 0 } }}>
            <LibraryPlatePreview fileId={fileId} resourceBasePath={resourceBasePath} thumbnailVersion={thumbnailVersion} plate={plate} size={48} />
          </Option>
        ))}
      </Select>
    </FormControl>
  )
}

export function LibraryPlateCardPicker({
  fileId,
  resourceBasePath,
  thumbnailVersion,
  plates,
  value,
  onChange,
  label = 'Plate',
  onPreview,
  collapsed = false,
  onToggleCollapsed
}: {
  fileId: string
  resourceBasePath?: string
  /** Cache-buster for thumbnail URLs (typically the file's `uploadedAt`). */
  thumbnailVersion?: string | null
  plates: ThreeMfIndex['plates']
  value: number
  onChange: (value: number) => void
  label?: string | null
  onPreview?: (() => void) | undefined
  /** Collapsed mode trades thumbnails for name-only chips (e.g. to give a viewer more room). */
  collapsed?: boolean
  /** When provided, renders a fold/unfold toggle at the end of the strip. */
  onToggleCollapsed?: (() => void) | undefined
}) {
  return (
    <FormControl sx={{ minWidth: 0 }}>
      {(label || onPreview) ? (
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 0.5, minWidth: 0 }}>
          {label ? (
            <Typography level="body-sm" textColor="text.tertiary" sx={{ minWidth: 0, flex: 1 }}>
              {label}
            </Typography>
          ) : <Box sx={{ flex: 1 }} />}
          {onPreview ? (
            <Button
              type="button"
              size="sm"
              variant="plain"
              color="neutral"
              startDecorator={<ViewInArRoundedIcon />}
              onClick={onPreview}
              sx={{ flexShrink: 0 }}
            >
              Preview
            </Button>
          ) : null}
        </Stack>
      ) : null}
      <Box
        sx={{
          width: '100%',
          minWidth: 0,
          display: 'flex',
          flexWrap: 'nowrap',
          gap: 1,
          overflowX: 'auto',
          overflowY: 'hidden',
          pb: 0.5,
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorX: 'contain',
          touchAction: 'pan-x',
          scrollSnapType: 'x proximity',
          scrollbarWidth: 'thin'
        }}
      >
        {plates.map((plate) => {
          const selected = value === plate.index
          return (
            <Sheet
              key={plate.index}
              component="button"
              type="button"
              variant={selected ? 'solid' : 'outlined'}
              color={selected ? 'primary' : 'neutral'}
              onClick={() => onChange(plate.index)}
              sx={{
                flex: collapsed ? '0 0 auto' : '0 0 140px',
                maxWidth: collapsed ? 200 : undefined,
                p: 0.75,
                border: 0,
                appearance: 'none',
                borderRadius: 'sm',
                cursor: 'pointer',
                textAlign: 'left',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                scrollSnapAlign: 'start'
              }}
            >
              {!collapsed && (
                <PlateCardThumb
                  fileId={fileId}
                  resourceBasePath={resourceBasePath}
                  thumbnailVersion={thumbnailVersion}
                  plate={plate}
                  selected={selected}
                />
              )}
              <Box sx={{ minWidth: 0 }}>
                <OverflowTooltipText
                  text={formatPlateTitle(plate)}
                  level="body-sm"
                  fontWeight="lg"
                  noWrap
                  textColor={selected ? 'primary.50' : undefined}
                />
                {hasCustomPlateName(plate) ? (
                  <Typography level="body-xs" textColor={selected ? 'primary.100' : 'neutral.500'}>
                    Plate {plate.index}
                  </Typography>
                ) : null}
              </Box>
            </Sheet>
          )
        })}
        {onToggleCollapsed ? (
          <Tooltip title={collapsed ? 'Show plate previews' : 'Hide plate previews'}>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? 'Show plate previews' : 'Hide plate previews'}
              sx={{ flex: '0 0 auto', alignSelf: 'center', ml: 'auto' }}
            >
              {collapsed ? <UnfoldMoreRoundedIcon fontSize="small" /> : <UnfoldLessRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
    </FormControl>
  )
}

export function LibraryPlatePreview({
  fileId,
  resourceBasePath,
  thumbnailVersion,
  plate,
  size = 48,
  subtitleFallback,
  noWrap = true
}: {
  fileId: string
  resourceBasePath?: string
  /** Cache-buster for thumbnail URLs (typically the file's `uploadedAt`). */
  thumbnailVersion?: string | null
  plate: ThreeMfIndex['plates'][number] | undefined
  size?: number
  subtitleFallback?: string | null
  noWrap?: boolean
}) {
  const subtitle = formatPlateObjects(plate) ?? subtitleFallback ?? null

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
      <PlateThumb fileId={fileId} resourceBasePath={resourceBasePath} thumbnailVersion={thumbnailVersion} plate={plate?.index ?? 1} size={size} />
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="body-sm" noWrap={noWrap}>{formatPlateTitle(plate)}</Typography>
        {subtitle && (
          <Typography level="body-xs" textColor="text.tertiary" noWrap={noWrap}>
            {subtitle}
          </Typography>
        )}
      </Stack>
    </Stack>
  )
}

/**
 * Plate thumbnail URL with an optional `v` cache-buster: overwrites keep the
 * file id and plate numbers, so the version (uploadedAt) is what makes the
 * browser fetch fresh images after a save-over.
 */
function buildPlateThumbnailPath(
  fileId: string,
  resourceBasePath: string | undefined,
  plate: number,
  thumbnailVersion: string | null | undefined
): string {
  const base = `${resourceBasePath ?? `/api/library/${fileId}`}/thumbnail?plate=${plate}`
  return thumbnailVersion ? `${base}&v=${encodeURIComponent(thumbnailVersion)}` : base
}

function formatPlateTitle(plate: { index: number; name: string | null } | undefined): string {
  if (!plate) return 'Plate 1'
  return plate.name?.trim() || `Plate ${plate.index}`
}

function hasCustomPlateName(plate: { name: string | null } | undefined): boolean {
  return Boolean(plate?.name?.trim())
}

function formatPlateObjects(plate: { objects?: { name: string }[] } | undefined): string | null {
  const names = plate?.objects?.map((object) => object.name.trim()).filter(Boolean) ?? []
  if (names.length === 0) return null
  const seen = new Set<string>()
  const unique: string[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    unique.push(name)
  }
  return unique.join(', ')
}

function formatPlateFallback(plate: ThreeMfIndex['plates'][number] | undefined): string {
  return `${plate?.filaments.length ?? 0} filament${(plate?.filaments.length ?? 0) === 1 ? '' : 's'}`
}

function PlateThumb({
  fileId,
  resourceBasePath,
  thumbnailVersion,
  plate,
  size = 32
}: {
  fileId: string
  resourceBasePath?: string
  thumbnailVersion?: string | null
  plate: number
  size?: number
}) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <SquareMediaFrame
        sx={{ width: size }}
        contentSx={{ backgroundColor: 'var(--joy-palette-neutral-800)', borderColor: 'var(--joy-palette-neutral-700)' }}
      >
        <Box />
      </SquareMediaFrame>
    )
  }
  return (
    <SquareMediaFrame
      sx={{ width: size }}
      contentSx={{ backgroundColor: 'var(--joy-palette-neutral-800)', borderColor: 'var(--joy-palette-neutral-700)' }}
    >
      <Box
        component="img"
        src={buildApiUrl(buildPlateThumbnailPath(fileId, resourceBasePath, plate, thumbnailVersion))}
        alt={`Plate ${plate}`}
        loading="lazy"
        onError={() => setFailed(true)}
        sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </SquareMediaFrame>
  )
}

function PlateCardThumb({
  fileId,
  resourceBasePath,
  thumbnailVersion,
  plate,
  selected
}: {
  fileId: string
  resourceBasePath?: string
  thumbnailVersion?: string | null
  plate: ThreeMfIndex['plates'][number]
  selected: boolean
}) {
  const [failed, setFailed] = useState(false)
  const serverThumbnailUrl = plate.hasThumbnail && !failed
    ? buildApiUrl(buildPlateThumbnailPath(fileId, resourceBasePath, plate.index, thumbnailVersion))
    : null

  // Client-side fallback (e.g. a sliced gcode.3mf with no embedded plate PNG): render the
  // plate's model at Bambu's iso angle. Only runs when there's no server thumbnail.
  const sceneProvider = getSceneThumbnailProvider()
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null)
  useEffect(() => { setFallbackUrl(null) }, [fileId, plate.index])
  useEffect(() => {
    if (serverThumbnailUrl || !sceneProvider) return
    let cancelled = false
    const controller = new AbortController()
    sceneProvider(fileId, plate.index, controller.signal)
      .then((url) => { if (!cancelled) setFallbackUrl(url) })
      .catch(() => { if (!cancelled) setFallbackUrl(null) })
    return () => { cancelled = true; controller.abort() }
  }, [serverThumbnailUrl, sceneProvider, fileId, plate.index])

  const thumbnailUrl = serverThumbnailUrl ?? fallbackUrl

  return (
    <Box
      sx={{
        aspectRatio: '1 / 1',
        borderRadius: 'xs',
        bgcolor: selected ? 'primary.600' : 'background.level1',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        width: '100%'
      }}
    >
      {thumbnailUrl
        ? (
          <Box
            component="img"
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            onError={() => { if (serverThumbnailUrl) setFailed(true) }}
            sx={{ width: '100%', height: '100%', objectFit: 'contain', p: 0.5 }}
          />
        )
        : <Typography level="body-xs" textColor={selected ? 'primary.100' : 'neutral.500'}>No preview</Typography>}
    </Box>
  )
}