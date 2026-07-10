import { Box, Stack, Tooltip, Typography } from '@mui/joy'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PrintJob } from '@printstream/shared'
import { buildApiUrl } from '../lib/apiUrl'
import { ImageLightbox } from './ImageLightbox'

export function JobHistoryMedia({
  job,
  size = 'default'
}: {
  job: PrintJob
  size?: 'default' | 'compact'
}) {
  const tileWidth = size === 'compact' ? 56 : 72
  const coverUrl = useBufferedImage(buildApiUrl(`/api/jobs/${job.id}/thumbnail`))
  const snapshotUrl = useBufferedImage(job.snapshotPath ? buildApiUrl(`/api/jobs/${job.id}/snapshot`) : null)

  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        minWidth: 0,
        width: '100%',
        maxWidth: '100%',
        flexShrink: 0,
        alignSelf: { xs: 'flex-start', sm: 'center' },
        justifyContent: { xs: 'flex-start', sm: 'flex-end' },
        flexWrap: { xs: 'wrap', sm: 'nowrap' },
        overflow: 'hidden'
      }}
    >
      <HistoryMediaTile
        label="Cover"
        alt={`Cover for ${job.jobName}`}
        imageUrl={coverUrl}
        objectFit="contain"
        width={tileWidth}
        placeholder={<PlaceholderImageIcon />}
      />
      <HistoryMediaTile
        label="Final"
        alt={`Final frame for ${job.jobName}`}
        imageUrl={snapshotUrl}
        objectFit="cover"
        width={tileWidth}
        placeholder={<PlaceholderCameraIcon />}
      />
    </Stack>
  )
}

function HistoryMediaTile({
  label,
  alt,
  imageUrl,
  objectFit,
  width,
  placeholder
}: {
  label: string
  alt: string
  imageUrl: string | null
  objectFit: 'contain' | 'cover'
  width: number
  placeholder: ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const canOpen = Boolean(imageUrl)

  return (
    <>
      <Stack spacing={0.5} sx={{ width, maxWidth: '100%', flexShrink: 0 }}>
        <Tooltip
          placement="top"
          arrow
          disableHoverListener={!canOpen}
          disableFocusListener={!canOpen}
          disableTouchListener={!canOpen}
          title={canOpen && imageUrl ? <ImagePreview src={imageUrl} alt={alt} /> : ''}
          sx={{ p: 0.5, maxWidth: 'none' }}
        >
          <Box
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            aria-label={canOpen ? `Open ${label.toLowerCase()} image` : undefined}
            onClick={() => canOpen && setDialogOpen(true)}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && canOpen) {
                event.preventDefault()
                setDialogOpen(true)
              }
            }}
            sx={{
              width: '100%',
              aspectRatio: '1 / 1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              borderRadius: 'var(--joy-radius-sm)',
              backgroundColor: 'var(--joy-palette-neutral-800)',
              border: '1px solid var(--joy-palette-neutral-700)',
              cursor: canOpen ? 'pointer' : 'default'
            }}
          >
            {imageUrl ? (
              <Box
                component="img"
                src={imageUrl}
                alt={alt}
                loading="lazy"
                sx={{
                  width: '100%',
                  height: '100%',
                  objectFit,
                  display: 'block'
                }}
              />
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
                {placeholder}
              </Box>
            )}
          </Box>
        </Tooltip>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ textAlign: 'center' }}>
          {label}
        </Typography>
      </Stack>

      {dialogOpen && canOpen && imageUrl && (
        <ImageLightbox src={imageUrl} alt={alt} title={label} onClose={() => setDialogOpen(false)} />
      )}
    </>
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
      {!showImage && !failed && <PreviewPlaceholder label="Loading preview..." />}
      {failed && <PreviewPlaceholder label="Preview unavailable" />}
    </Box>
  )
}

function PreviewPlaceholder({ label }: { label: string }) {
  return (
    <Stack spacing={1} alignItems="center" justifyContent="center" sx={{ px: 2, py: 3, minHeight: 180 }}>
      <Typography level="body-sm" textColor="text.tertiary">
        {label}
      </Typography>
    </Stack>
  )
}

function PlaceholderImageIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 28, height: 28, color: 'var(--joy-palette-neutral-500)', fill: 'currentColor' }}>
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </Box>
  )
}

function PlaceholderCameraIcon() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 28, height: 28, color: 'var(--joy-palette-neutral-500)', fill: 'currentColor' }}>
      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
    </Box>
  )
}

function useBufferedImage(requestUrl: string | null): string | null {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setImageUrl(null)

    if (!requestUrl) {
      return
    }

    let cancelled = false
    let retryTimer: number | null = null
    const controller = new AbortController()

    const loadImage = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(requestUrl, {
            headers: { Accept: 'image/*' },
            signal: controller.signal
          })
          if (!response.ok) throw new Error('Image request failed')
          const blob = await response.blob()
          if (cancelled || controller.signal.aborted) return
          const objectUrl = URL.createObjectURL(blob)
          objectUrlRef.current = objectUrl
          setImageUrl(objectUrl)
          return
        } catch {
          if (cancelled || controller.signal.aborted) return
          if (attempt === 2) return
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, 300 * (attempt + 1))
          })
        }
      }
    }

    void loadImage()

    return () => {
      cancelled = true
      controller.abort()
      if (retryTimer != null) window.clearTimeout(retryTimer)
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [requestUrl])

  return imageUrl
}