import { Box, Button, CircularProgress, IconButton, ModalClose, ModalDialog, Stack, Tooltip, Typography } from '@mui/joy'
import FullscreenExitRoundedIcon from '@mui/icons-material/FullscreenExitRounded'
import FullscreenRoundedIcon from '@mui/icons-material/FullscreenRounded'
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined'
import LightbulbRoundedIcon from '@mui/icons-material/LightbulbRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BackAwareModal as Modal } from './BackAwareModal'
import { useCameraStream } from '../hooks/useCameraStream'
import { useElementVisibility } from '../hooks/useElementVisibility'
import { usePrinterFtpActivityActive } from '../hooks/usePrinterFtpActivity'
import { usePrinterDispatchUploadActive } from '../hooks/usePrintDispatchJobs'
import { useSnapshotInterest } from '../hooks/useSnapshotInterest'
import { buildApiUrl } from '../lib/apiUrl'
import { resolveBufferedSnapshotSrc } from '../lib/printerCardMedia'

interface CoverMedia {
  title: string
  src: string | null
  loaded: boolean
  failed: boolean
  progress?: number | null
  loading?: boolean
}

interface CameraMedia {
  printerId: string
  printerName: string
  showTile?: boolean
  showWide?: boolean
  openRequestedAt?: number | null
  onDialogClose?: () => void
  paused?: boolean
  freezeThumbnail?: boolean
  lightControls?: Array<{
    key: string
    label: string
    on: boolean
    onToggle: () => void
  }>
}

const PREVIEW_TOOLTIP_MAX_HEIGHT = 360
const PREVIEW_TOOLTIP_VIEWPORT_RATIO = 0.6
const PREVIEW_TOOLTIP_ENTER_DELAY_MS = 150
const CAMERA_DIALOG_MEDIA_MAX_HEIGHT = 'calc(100dvh - 132px)'
const CAMERA_SNAPSHOT_RESUME_DELAY_MS = 2_000
const DEFAULT_MEDIA_TILE_SIZE = { xs: 54, sm: 64 } as const
const DEFAULT_WIDE_CAMERA_ASPECT_RATIO = 16 / 9

function resolvePreviewTooltipPlacement(anchor: HTMLElement | null): 'top' | 'bottom' {
  if (!anchor || typeof window === 'undefined') return 'top'

  const rect = anchor.getBoundingClientRect()
  const previewHeight = Math.min(window.innerHeight * PREVIEW_TOOLTIP_VIEWPORT_RATIO, PREVIEW_TOOLTIP_MAX_HEIGHT)
  const topSpace = rect.top
  const bottomSpace = window.innerHeight - rect.bottom

  if (topSpace >= previewHeight || topSpace >= bottomSpace) {
    return 'top'
  }

  return 'bottom'
}

function usePreviewTooltip(anchorRef: React.RefObject<HTMLElement | null>, disabled: boolean) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top')
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current == null) return
    clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }, [])

  const showTooltip = useCallback(() => {
    if (disabled) return
    clearOpenTimer()
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      setPlacement(resolvePreviewTooltipPlacement(anchorRef.current))
      setOpen(true)
    }, PREVIEW_TOOLTIP_ENTER_DELAY_MS)
  }, [anchorRef, clearOpenTimer, disabled])

  const hideTooltip = useCallback(() => {
    clearOpenTimer()
    setOpen(false)
  }, [clearOpenTimer])

  useEffect(() => {
    if (disabled) hideTooltip()
  }, [disabled, hideTooltip])

  useEffect(() => clearOpenTimer, [clearOpenTimer])

  useEffect(() => {
    if (!open) return undefined

    const updatePlacement = () => setPlacement(resolvePreviewTooltipPlacement(anchorRef.current))

    window.addEventListener('resize', updatePlacement)
    return () => window.removeEventListener('resize', updatePlacement)
  }, [anchorRef, open])

  return {
    open,
    placement,
    showTooltip,
    hideTooltip
  }
}

export function PrinterJobMediaStrip({
  cover,
  camera,
  children,
  mobileTileSize = DEFAULT_MEDIA_TILE_SIZE.xs,
  layout = 'inline',
  showCenter = true,
  centerJustify = 'space-between'
}: {
  cover?: CoverMedia | null
  camera?: CameraMedia | null
  children: ReactNode
  mobileTileSize?: number
  layout?: 'inline' | 'snapshot-above'
  showCenter?: boolean
  centerJustify?: 'center' | 'space-between'
}) {
  const stackedCamera = layout === 'snapshot-above' && Boolean(camera?.showWide)
  const showInlineCamera = Boolean(camera?.showTile)
  const showDetachedSpacer = !stackedCamera && !showCenter && Boolean(cover) && showInlineCamera
  const tileSize = { xs: mobileTileSize, sm: DEFAULT_MEDIA_TILE_SIZE.sm }
  const centerContent = showCenter ? (
    <Stack
      sx={{
        flex: 1,
        minWidth: 0,
        alignSelf: 'stretch',
        justifyContent: centerJustify,
        py: { xs: 0, sm: 0.25 }
      }}
    >
      {children}
    </Stack>
  ) : null

  if (stackedCamera && camera) {
    return (
      <Stack spacing={{ xs: 0.75, sm: 1 }} sx={{ minWidth: 0 }}>
        <CameraTile camera={camera} tileSize={tileSize} presentation="wide" />
        {(cover || centerContent || showInlineCamera) && (
          <Stack direction="row" spacing={{ xs: 0.75, sm: 1 }} alignItems="center" sx={{ minWidth: 0 }}>
            {cover && <CoverTile cover={cover} tileSize={tileSize} />}
            {centerContent}
            {showInlineCamera && <CameraTile camera={camera} tileSize={tileSize} presentation="tile" />}
          </Stack>
        )}
      </Stack>
    )
  }

  return (
    <Stack direction="row" spacing={{ xs: 0.75, sm: 1 }} alignItems="center" sx={{ minWidth: 0 }}>
      {cover && <CoverTile cover={cover} tileSize={tileSize} />}
      {centerContent}
      {showDetachedSpacer && <Box sx={{ flex: 1, minWidth: 0 }} />}
      {showInlineCamera && camera && <CameraTile camera={camera} tileSize={tileSize} presentation="tile" />}
    </Stack>
  )
}

function CoverTile({ cover, tileSize }: { cover: CoverMedia; tileSize: { xs: number; sm: number } }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const canOpen = !cover.failed && cover.loaded && Boolean(cover.src)
  const showImage = !cover.failed && Boolean(cover.src)
  const showDeterminateProgress = !showImage && !cover.failed && !cover.loaded && cover.progress != null
  const showIndeterminateProgress = !showImage && !cover.failed && !cover.loaded && !showDeterminateProgress && cover.loading !== false
  const previewTooltip = usePreviewTooltip(rootRef, !canOpen)

  return (
    <>
      <Tooltip
        placement={previewTooltip.placement}
        arrow
        open={previewTooltip.open}
        disableHoverListener
        disableFocusListener
        disableTouchListener
        title={canOpen && cover.src ? <ImagePreview src={cover.src} alt={`${cover.title} cover`} /> : ''}
        sx={{ p: 0.5, maxWidth: 'none' }}
      >
        <Box
          ref={rootRef}
          role="button"
          tabIndex={0}
          aria-label={`Open ${cover.title} cover`}
          onMouseEnter={previewTooltip.showTooltip}
          onMouseLeave={previewTooltip.hideTooltip}
          onFocus={previewTooltip.showTooltip}
          onBlur={previewTooltip.hideTooltip}
          onClick={() => {
            if (!canOpen) return
            previewTooltip.hideTooltip()
            setDialogOpen(true)
          }}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && canOpen) {
              event.preventDefault()
              previewTooltip.hideTooltip()
              setDialogOpen(true)
            }
          }}
          sx={{
            position: 'relative',
            flexShrink: 0,
            height: tileSize,
            width: tileSize,
            borderRadius: 'sm',
            overflow: 'hidden',
            border: '1px solid var(--joy-palette-neutral-700)',
            backgroundColor: 'var(--joy-palette-neutral-800)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: canOpen ? 'pointer' : 'default'
          }}
        >
          {showImage && cover.src ? (
            <Box component="img" src={cover.src} alt={`${cover.title} cover`} sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : null}
          {showDeterminateProgress && <CircularProgress size="sm" determinate value={cover.progress ?? 0} sx={{ position: 'absolute' }} />}
          {showIndeterminateProgress && <CircularProgress size="sm" determinate={false} />}
          {cover.failed && <PlaceholderImageIcon />}
        </Box>
      </Tooltip>

      {dialogOpen && canOpen && cover.src && (
        <Modal open onClose={() => setDialogOpen(false)}>
          <ModalDialog sx={{ p: 1.5, width: { xs: '95vw', sm: '90vw', md: '70vw' }, maxWidth: 720 }}>
            <ModalClose />
            <Typography level="title-md" sx={{ mb: 1 }} noWrap>{cover.title}</Typography>
            <Box
              component="img"
              src={cover.src}
              alt={`${cover.title} plate cover`}
              sx={{
                width: '100%',
                height: 'auto',
                display: 'block',
                borderRadius: 'sm',
                backgroundColor: 'var(--joy-palette-neutral-800)'
              }}
            />
          </ModalDialog>
        </Modal>
      )}
    </>
  )
}

function CameraTile({
  camera,
  tileSize,
  presentation = 'tile'
}: {
  camera: CameraMedia
  tileSize: { xs: number; sm: number }
  presentation?: 'tile' | 'wide'
}) {
  const showTile = presentation === 'wide' ? Boolean(camera.showWide) : Boolean(camera.showTile)
  const wide = presentation === 'wide'
  const ftpActive = usePrinterFtpActivityActive(camera.printerId)
  const uploadActive = usePrinterDispatchUploadActive(camera.printerId)
  const cameraPaused = Boolean(camera.paused || uploadActive || ftpActive)
  const thumbnailFrozen = Boolean(camera.freezeThumbnail)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dialogContentRef = useRef<HTMLDivElement | null>(null)
  const previousPrinterIdRef = useRef(camera.printerId)
  const cachedSnapshot = snapshotCache.get(camera.printerId)
  const cachedSnapshotSrc = cachedSnapshot && cachedSnapshot.complete && cachedSnapshot.naturalWidth > 0
    ? cachedSnapshot.currentSrc || cachedSnapshot.src || null
    : null
  const [aspectRatio, setAspectRatio] = useState(() => (
    cachedSnapshot && cachedSnapshot.naturalWidth > 0 && cachedSnapshot.naturalHeight > 0
      ? cachedSnapshot.naturalWidth / cachedSnapshot.naturalHeight
      : DEFAULT_WIDE_CAMERA_ASPECT_RATIO
  ))
  const [failed, setFailed] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [displaySrc, setDisplaySrc] = useState<string | null>(() => cachedSnapshotSrc)
  const displaySrcRef = useRef<string | null>(cachedSnapshotSrc)
  const liveCameraWasActiveRef = useRef(false)
  const [snapshotCooldownActive, setSnapshotCooldownActive] = useState(false)
  const thumbnailNeedsInitialSnapshot = thumbnailFrozen && !cachedSnapshotSrc
  const snapshotLoadingEnabled = !cameraPaused && !dialogOpen && !snapshotCooldownActive && (!thumbnailFrozen || thumbnailNeedsInitialSnapshot)
  const watchVisible = useElementVisibility(rootRef, snapshotLoadingEnabled)
  const snapshotWatchingEnabled = snapshotLoadingEnabled && watchVisible
  const snapshotVersion = useSnapshotInterest(camera.printerId, snapshotWatchingEnabled)
  const snapshotUrl = buildApiUrl(`/api/camera/${camera.printerId}/snapshot?t=${snapshotVersion}`)
  const imageVisible = Boolean(displaySrc) && !failed
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const previewTooltip = usePreviewTooltip(rootRef, failed || wide)

  useEffect(() => {
    if (camera.openRequestedAt == null || failed) return
    setDialogOpen(true)
  }, [camera.openRequestedAt, failed])

  useEffect(() => {
    if (dialogOpen) {
      liveCameraWasActiveRef.current = true
      setSnapshotCooldownActive(true)
      return
    }

    if (!liveCameraWasActiveRef.current) {
      setSnapshotCooldownActive(false)
      return
    }

    const timer = window.setTimeout(() => {
      liveCameraWasActiveRef.current = false
      setSnapshotCooldownActive(false)
    }, CAMERA_SNAPSHOT_RESUME_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [dialogOpen])

  useEffect(() => {
    displaySrcRef.current = displaySrc
  }, [displaySrc])

  useEffect(() => {
    if (!cachedSnapshot || cachedSnapshot.naturalWidth <= 0 || cachedSnapshot.naturalHeight <= 0) return
    setAspectRatio(cachedSnapshot.naturalWidth / cachedSnapshot.naturalHeight)
  }, [cachedSnapshot])

  useEffect(() => {
    setDisplaySrc((current) => resolveBufferedSnapshotSrc({
      previousPrinterId: previousPrinterIdRef.current,
      printerId: camera.printerId,
      currentDisplaySrc: current,
      cachedSnapshotSrc
    }))
    previousPrinterIdRef.current = camera.printerId
    setFailed(false)
  }, [cachedSnapshotSrc, camera.printerId])

  useEffect(() => {
    if (cameraPaused || dialogOpen || snapshotCooldownActive || (thumbnailFrozen && !thumbnailNeedsInitialSnapshot)) {
      if (cachedSnapshotSrc) {
        setDisplaySrc(cachedSnapshotSrc)
        setFailed(false)
      }
      return
    }

    if (snapshotVersion === 0 && !cachedSnapshotSrc) {
      return
    }

    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      snapshotCache.set(camera.printerId, img)
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setAspectRatio(img.naturalWidth / img.naturalHeight)
      }
      setDisplaySrc(img.currentSrc || img.src)
      setFailed(false)
    }
    img.onerror = () => {
      if (cancelled) return
      if (!displaySrcRef.current) {
        setFailed(true)
      }
    }

    setFailed(false)
    img.src = snapshotUrl

    return () => {
      cancelled = true
      img.onload = null
      img.onerror = null
      img.src = ''
    }
  }, [
    cachedSnapshotSrc,
    cameraPaused,
    camera.printerId,
    dialogOpen,
    snapshotCooldownActive,
    snapshotUrl,
    snapshotVersion,
    thumbnailFrozen,
    thumbnailNeedsInitialSnapshot
  ])

  useEffect(() => {
    if (!dialogOpen) {
      setFullscreenActive(false)
      return
    }

    const onFullscreenChange = () => {
      setFullscreenActive(document.fullscreenElement === dialogContentRef.current)
    }

    document.addEventListener('fullscreenchange', onFullscreenChange)
    onFullscreenChange()

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [dialogOpen])

  const toggleFullscreen = useCallback(() => {
    const element = dialogContentRef.current
    if (!element) return

    if (document.fullscreenElement === element) {
      void document.exitFullscreen().catch(() => {})
      return
    }

    void element.requestFullscreen().catch(() => {})
  }, [])

  return (
    <>
      {showTile && (
        <Tooltip
          placement={previewTooltip.placement}
          arrow
          open={previewTooltip.open}
          disableHoverListener
          disableFocusListener
          disableTouchListener
          title={!failed && displaySrc ? <ImagePreview src={displaySrc} alt={`${camera.printerName} camera`} /> : ''}
          sx={{ p: 0.5, maxWidth: 'none' }}
        >
          <Box
            ref={rootRef}
            role="button"
            tabIndex={0}
            aria-label={`Open ${camera.printerName} camera`}
            onMouseEnter={previewTooltip.showTooltip}
            onMouseLeave={previewTooltip.hideTooltip}
            onFocus={previewTooltip.showTooltip}
            onBlur={previewTooltip.hideTooltip}
            onClick={() => {
              if (failed) return
              previewTooltip.hideTooltip()
              setDialogOpen(true)
            }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && !failed) {
                event.preventDefault()
                previewTooltip.hideTooltip()
                setDialogOpen(true)
              }
            }}
            sx={{
              position: 'relative',
              flexShrink: wide ? 1 : 0,
              minWidth: 0,
              height: wide ? 'auto' : tileSize,
              width: wide ? '100%' : tileSize,
              aspectRatio: wide ? aspectRatio : undefined,
              borderRadius: wide ? 'md' : 'sm',
              overflow: 'hidden',
              border: '1px solid var(--joy-palette-neutral-700)',
              backgroundColor: 'var(--joy-palette-neutral-800)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: failed ? 'default' : 'pointer'
            }}
          >
            {!failed && displaySrc ? (
              <SmoothSnapshotImage src={displaySrc} alt={`${camera.printerName} camera`} visible={imageVisible} />
            ) : null}
            {(failed || !imageVisible) && <PlaceholderCameraIcon />}
            {cameraPaused && <PausedCameraBadge />}
          </Box>
        </Tooltip>
      )}

      {dialogOpen && !failed && (
        <Modal open onClose={() => {
          setDialogOpen(false)
          camera.onDialogClose?.()
        }}>
          <ModalDialog
            sx={{
              p: 1.5,
              width: { xs: '95vw', sm: '90vw', md: '80vw' },
              maxWidth: 1280,
              maxHeight: 'calc(100dvh - 16px)',
              overflow: 'hidden'
            }}
          >
            <ModalClose sx={{ top: 12 }} />
            <Box
              ref={dialogContentRef}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                maxHeight: 'calc(100dvh - 64px)',
                minHeight: 0,
                overflow: 'auto',
                // Native fullscreen (the in-dialog fullscreen button) makes THIS element
                // fill the screen. The modal-tuned height caps below would otherwise leave
                // black gaps and pin the stream to the top; in fullscreen we fill the
                // viewport, float the header as an overlay, and let the stream centre in the
                // whole screen instead. Do NOT set `position` here — the UA `:fullscreen`
                // rule already pins the element with position: fixed; inset: 0.
                '&:fullscreen': {
                  width: '100%',
                  height: '100%',
                  maxHeight: '100dvh',
                  overflow: 'hidden',
                  backgroundColor: '#000'
                },
                '&:fullscreen .ps-camera-header': {
                  position: 'absolute',
                  top: 8,
                  left: 12,
                  right: 12,
                  zIndex: 2,
                  mb: 0,
                  px: 1,
                  py: 0.5,
                  borderRadius: 'sm',
                  backgroundColor: 'rgba(0, 0, 0, 0.45)'
                },
                '&:fullscreen .ps-camera-stream-surface': {
                  flex: 1,
                  minHeight: 0,
                  maxHeight: 'none',
                  width: '100%',
                  border: 'none',
                  borderRadius: 0
                },
                // Fill the screen as much as possible without distorting or cropping the
                // feed: the canvas spans the viewport and `object-fit: contain` scales the
                // frame up to fit while preserving its aspect ratio (letterboxed on the
                // black surface when the camera and screen ratios differ).
                '&:fullscreen .ps-camera-stream-surface canvas': {
                  width: '100%',
                  height: '100%',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain'
                }
              }}
            >
              <Stack className="ps-camera-header" direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mb: 1, pr: 4 }}>
                <Typography level="title-md">{camera.printerName} camera</Typography>
                <Stack direction="row" spacing={0.5}>
                  {camera.lightControls?.map((light) => (
                    <Tooltip key={light.key} title={light.on ? `Turn ${light.label.toLowerCase()} off` : `Turn ${light.label.toLowerCase()} on`}>
                      <Button
                        size="sm"
                        variant="soft"
                        color={light.on ? 'warning' : 'neutral'}
                        aria-label={light.on ? `Turn ${light.label.toLowerCase()} off` : `Turn ${light.label.toLowerCase()} on`}
                        aria-pressed={light.on}
                        onClick={light.onToggle}
                        startDecorator={light.on ? <LightbulbRoundedIcon /> : <LightbulbOutlinedIcon />}
                        sx={{ minWidth: 0 }}
                      >
                        {light.label}
                      </Button>
                    </Tooltip>
                  ))}
                  <Tooltip title={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'}>
                    <IconButton
                      size="sm"
                      variant="soft"
                      color="neutral"
                      aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'}
                      aria-pressed={fullscreenActive}
                      onClick={toggleFullscreen}
                    >
                      {fullscreenActive ? <FullscreenExitRoundedIcon /> : <FullscreenRoundedIcon />}
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
              <CameraStreamBox
                printerId={camera.printerId}
                printerName={camera.printerName}
                snapshotVersion={snapshotVersion}
                paused={cameraPaused}
              />
            </Box>
          </ModalDialog>
        </Modal>
      )}
    </>
  )
}

function SmoothSnapshotImage({ src, alt, visible }: { src: string; alt: string; visible: boolean }) {
  const [visibleSrc, setVisibleSrc] = useState(src)
  const [loadingSrc, setLoadingSrc] = useState<string | null>(null)

  useEffect(() => {
    if (src === visibleSrc || src === loadingSrc) return
    setLoadingSrc(src)
  }, [loadingSrc, src, visibleSrc])

  return (
    <Box
      role="img"
      aria-label={alt}
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: visible ? 'block' : 'none',
        overflow: 'hidden',
        backgroundColor: 'var(--joy-palette-neutral-900)'
      }}
    >
      <Box
        component="img"
        src={visibleSrc}
        alt=""
        aria-hidden
        draggable={false}
        sx={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block'
        }}
      />
      {loadingSrc && (
        <Box
          component="img"
          key={loadingSrc}
          src={loadingSrc}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => {
            setVisibleSrc(loadingSrc)
            setLoadingSrc(null)
          }}
          onError={() => setLoadingSrc(null)}
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            opacity: 0,
            pointerEvents: 'none'
          }}
        />
      )}
    </Box>
  )
}

function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [displaySrc, setDisplaySrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const nextImage = new Image()

    nextImage.onload = () => {
      if (cancelled) return
      setDisplaySrc(src)
      setFailed(false)
    }

    nextImage.onerror = () => {
      if (cancelled) return
      setFailed((current) => (displaySrc ? current : true))
    }

    nextImage.src = src

    return () => {
      cancelled = true
    }
  }, [displaySrc, src])

  const showImage = Boolean(displaySrc) && !failed

  return (
    <Box
      sx={{
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden',
        backgroundColor: 'var(--joy-palette-neutral-900)',
        lineHeight: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        maxWidth: { xs: 'min(60vw, 360px)', sm: 360 },
        maxHeight: '60vh',
        minWidth: showImage || failed ? undefined : { xs: 'min(60vw, 360px)', sm: 360 },
        minHeight: showImage || failed ? undefined : 180
      }}
    >
      <Box
        component="img"
        src={displaySrc ?? undefined}
        alt={alt}
        sx={{
          display: showImage ? 'block' : 'none',
          width: 'auto',
          height: 'auto',
          maxWidth: '100%',
          maxHeight: '60vh',
          objectFit: 'contain'
        }}
      />
      {!showImage && !failed && <CameraLoadingPlaceholder label="Loading preview..." />}
      {failed && <CameraLoadingPlaceholder label="Preview unavailable" />}
    </Box>
  )
}

function CameraStreamBox({
  printerId,
  printerName,
  snapshotVersion,
  paused = false
}: {
  printerId: string
  printerName: string
  snapshotVersion: number
  paused?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const [hasFrame, setHasFrame] = useState(false)

  useEffect(() => {
    sizeRef.current = { w: 0, h: 0 }
    setHasFrame(false)
  }, [printerId])

  const markFrameReady = useCallback((_width: number, _height: number) => {
    setHasFrame(true)
  }, [])

  useEffect(() => {
    if (paused) return
    if (hasFrame) return

    const canvas = canvasRef.current
    if (!canvas) return

    const cached = snapshotCache.get(printerId)
    if (cached && cached.complete && cached.naturalWidth > 0) {
      paintImage(canvas, sizeRef.current, cached.naturalWidth, cached.naturalHeight, (ctx, width, height) => {
        ctx.drawImage(cached, 0, 0, width, height)
      })
      markFrameReady(cached.naturalWidth, cached.naturalHeight)
      return
    }

    const img = new Image()
    img.src = buildApiUrl(`/api/camera/${printerId}/snapshot?t=${snapshotVersion}`)
    let cancelled = false
    img.onload = () => {
      if (cancelled) return
      snapshotCache.set(printerId, img)
      paintImage(canvas, sizeRef.current, img.naturalWidth, img.naturalHeight, (ctx, width, height) => {
        ctx.drawImage(img, 0, 0, width, height)
      })
      markFrameReady(img.naturalWidth, img.naturalHeight)
    }
    return () => {
      cancelled = true
    }
  }, [hasFrame, markFrameReady, paused, printerId, snapshotVersion])

  const onFrame = useCallback((bitmap: ImageBitmap) => {
    const canvas = canvasRef.current
    if (!canvas) {
      bitmap.close()
      return
    }
    paintImage(canvas, sizeRef.current, bitmap.width, bitmap.height, (ctx, width, height) => {
      ctx.drawImage(bitmap, 0, 0, width, height)
    })
    markFrameReady(bitmap.width, bitmap.height)
    bitmap.close()
  }, [markFrameReady])
  useCameraStream(printerId, onFrame, !paused)

  return (
    <Box
      className="ps-camera-stream-surface"
      sx={{
        position: 'relative',
        width: '100%',
        maxHeight: CAMERA_DIALOG_MEDIA_MAX_HEIGHT,
        minHeight: hasFrame ? undefined : { xs: 220, sm: 320 },
        borderRadius: 'sm',
        overflow: 'hidden',
        border: '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Box
        component="canvas"
        ref={canvasRef}
        aria-label={`${printerName} camera`}
        sx={{
          width: 'auto',
          height: 'auto',
          maxWidth: '100%',
          maxHeight: CAMERA_DIALOG_MEDIA_MAX_HEIGHT,
          display: hasFrame ? 'block' : 'none'
        }}
      />
      {!hasFrame && <CameraLoadingPlaceholder label={paused ? 'Camera paused while printer storage is busy' : 'Starting camera...'} />}
    </Box>
  )
}

function CameraLoadingPlaceholder({ label }: { label: string }) {
  return (
    <Stack spacing={1} alignItems="center" justifyContent="center" sx={{ width: '100%', height: '100%', minHeight: 'inherit', px: 2, py: 3, textAlign: 'center' }}>
      <Box sx={{ width: 72, height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <PlaceholderCameraIcon />
      </Box>
      <Typography level="body-sm" textColor="text.tertiary">{label}</Typography>
    </Stack>
  )
}

function PausedCameraBadge() {
  return (
    <Box
      sx={{
        position: 'absolute',
        right: 4,
        bottom: 4,
        width: 24,
        height: 24,
        borderRadius: '999px',
        backgroundColor: 'rgba(15, 23, 42, 0.82)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        color: 'var(--joy-palette-warning-300)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 16,
        boxShadow: 'sm',
        zIndex: 1,
        pointerEvents: 'none'
      }}
    >
      <PauseRoundedIcon fontSize="inherit" />
    </Box>
  )
}

function paintImage(
  canvas: HTMLCanvasElement,
  size: { w: number; h: number },
  srcW: number,
  srcH: number,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void
): void {
  if (size.w !== srcW || size.h !== srcH) {
    canvas.width = srcW
    canvas.height = srcH
    size.w = srcW
    size.h = srcH
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  draw(ctx, srcW, srcH)
}

function PlaceholderImageIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: '60%', height: '60%', color: 'var(--joy-palette-neutral-500)', fill: 'currentColor' }}>
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </Box>
  )
}

function PlaceholderCameraIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: '60%', height: '60%', color: 'var(--joy-palette-neutral-500)', fill: 'currentColor' }}>
      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
    </Box>
  )
}

const snapshotCache = new Map<string, HTMLImageElement>()