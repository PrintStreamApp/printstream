import type { AppLandingPageSetting } from '@printstream/shared'
import { printerViewPath } from './printerViewRoutes'

export interface LandingPageOption {
  value: AppLandingPageSetting
  label: string
}

export const CORE_LANDING_PAGE_OPTIONS: ReadonlyArray<LandingPageOption> = [
  { value: '/printers', label: 'Printers' },
  { value: '/library', label: 'Library' },
  { value: '/jobs', label: 'Jobs' },
  { value: '/stats', label: 'Stats' },
  { value: '/settings', label: 'Settings' }
]

/**
 * Offer each saved printer view as a landing target (`/printers/views/<id>`),
 * inserted right after the plain "Printers" entry so the views read as
 * refinements of that page rather than pages of their own. Plain "Printers"
 * keeps its distinct meaning: it opens the device's default view, while a view
 * entry pins that view regardless of the device default.
 */
export function withPrinterViewLandingPageOptions(
  options: ReadonlyArray<LandingPageOption>,
  views: ReadonlyArray<{ id: string; name: string }>
): ReadonlyArray<LandingPageOption> {
  if (views.length === 0) return options
  const viewOptions = views.map((view) => ({
    value: printerViewPath(view.id),
    label: `Printers: ${view.name}`
  }))
  const printersIndex = options.findIndex((option) => option.value === '/printers')
  if (printersIndex === -1) return [...options, ...viewOptions]
  return [
    ...options.slice(0, printersIndex + 1),
    ...viewOptions,
    ...options.slice(printersIndex + 1)
  ]
}
