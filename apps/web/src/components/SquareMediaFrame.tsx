/**
 * Shared square media surface for thumbnails, preview tiles, and icon fallbacks.
 * Keeps Joy UI's `AspectRatio` structure consistent across list and card layouts.
 */
import { useState } from 'react'
import { AspectRatio, Box, type AspectRatioProps, type BoxProps } from '@mui/joy'
import type { ReactNode } from 'react'

function sxArray<T>(value: T | readonly T[] | undefined): T[] {
  if (Array.isArray(value)) return [...value]
  return value == null ? [] : [value as T]
}

export function SquareMediaFrame({
  children,
  sx,
  contentSx,
  ratio = '1 / 1'
}: {
  children: ReactNode
  sx?: AspectRatioProps['sx']
  contentSx?: BoxProps['sx']
  ratio?: AspectRatioProps['ratio']
}) {
  return (
    <AspectRatio
      ratio={ratio}
      sx={[
        {
          width: '100%',
          maxWidth: '100%',
          flexShrink: 0,
          '--AspectRatio-radius': 'var(--joy-radius-sm)'
        },
        ...sxArray(sx)
      ]}
    >
      <Box
        sx={[
          {
            position: 'relative',
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'inherit',
            overflow: 'hidden',
            backgroundColor: 'background.level2',
            border: '1px solid',
            borderColor: 'neutral.outlinedBorder'
          },
          ...sxArray(contentSx)
        ]}
      >
        {children}
      </Box>
    </AspectRatio>
  )
}

export function SquareImageFrame({
  src,
  alt,
  loading = 'lazy',
  sx,
  contentSx,
  imgSx,
  hideOnError = false
}: {
  src: string
  alt: string
  loading?: 'eager' | 'lazy'
  sx?: AspectRatioProps['sx']
  contentSx?: BoxProps['sx']
  imgSx?: BoxProps['sx']
  hideOnError?: boolean
}) {
  const [failed, setFailed] = useState(false)

  if (failed && hideOnError) return null

  return (
    <SquareMediaFrame sx={sx} contentSx={contentSx}>
      {!failed ? (
        <Box
          component="img"
          src={src}
          alt={alt}
          loading={loading}
          onError={() => setFailed(true)}
          sx={[
            {
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block'
            },
            ...sxArray(imgSx)
          ]}
        />
      ) : (
        <Box />
      )}
    </SquareMediaFrame>
  )
}