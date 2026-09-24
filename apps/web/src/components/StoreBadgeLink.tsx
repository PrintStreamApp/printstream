/** Official store badges shared by app promotion and download surfaces. */
import { Box } from '@mui/joy'
import type { MouseEventHandler } from 'react'

export type NativeAppStore = 'google-play' | 'microsoft-store'

const STORE_BADGES: Record<NativeAppStore, {
  alt: string
  src: string
  width: number
}> = {
  'google-play': {
    alt: 'Get it on Google Play',
    src: '/store-badges/google-play.png',
    // Google's official PNG includes transparent clear space around the badge.
    width: 180
  },
  'microsoft-store': {
    alt: 'Download from Microsoft Store',
    src: '/store-badges/microsoft-store.svg',
    width: 161
  }
}

// The official files use different canvases: Google's PNG includes generous
// transparent clear space while Microsoft's SVG hugs the visible badge. A
// shared frame keeps their visible centres and every surrounding row aligned
// without modifying or cropping either store owner's artwork.
const BADGE_FRAME_WIDTH = 180
export const STORE_BADGE_FRAME_HEIGHT = 70

interface StoreBadgeLinkProps {
  store: NativeAppStore
  href: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}

/** Links to an app listing with the store owner's unmodified distribution badge. */
export function StoreBadgeLink({ store, href, onClick }: StoreBadgeLinkProps) {
  const badge = STORE_BADGES[store]

  return (
    <Box
      component="a"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={badge.alt}
      onClick={onClick}
      sx={{
        alignItems: 'center',
        borderRadius: 'sm',
        display: 'inline-flex',
        flex: '0 0 auto',
        height: STORE_BADGE_FRAME_HEIGHT,
        justifyContent: 'center',
        lineHeight: 0,
        maxWidth: '100%',
        transition: 'filter 120ms ease',
        width: BADGE_FRAME_WIDTH,
        '&:hover': { filter: 'brightness(1.08)' },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.400',
          outlineOffset: 2
        }
      }}
    >
      <Box
        component="img"
        src={badge.src}
        alt=""
        sx={{
          border: store === 'microsoft-store' ? '1px solid rgba(255, 255, 255, 0.72)' : undefined,
          borderRadius: store === 'microsoft-store' ? '5px' : undefined,
          display: 'block',
          height: 'auto',
          maxWidth: '100%',
          width: badge.width
        }}
      />
    </Box>
  )
}
