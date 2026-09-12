/**
 * Core discovery seam for cloud-only chrome around public tools.
 *
 * The private leaf exports only the header and footer, so opening the editor does not pull the
 * cloud platform views or plugin graph through the full private-module registry. In self-hosted,
 * native, OSS, and Node-test builds the glob is empty and no public-tool chrome exists.
 */
import type { ComponentType } from 'react'

export interface PublicHeaderProps {
  isAuthenticated: boolean
  authPending?: boolean
  appHref: string
  /** Home supplies smooth scrolling; other public routes link back to the home-page anchors. */
  onSectionSelect?: (id: string) => void
}

export interface PublicToolChrome {
  Header: ComponentType<PublicHeaderProps>
  Footer: ComponentType
}

let discovered: Record<string, { default?: PublicToolChrome }> = {}
try {
  discovered = import.meta.glob('../private/*/publicToolChrome.tsx', { eager: true }) as Record<
    string,
    { default?: PublicToolChrome }
  >
} catch {
  discovered = {}
}

export const publicToolChrome = Object.keys(discovered)
  .sort()
  .map((key) => discovered[key]?.default)
  .find((entry): entry is PublicToolChrome => Boolean(entry)) ?? null
