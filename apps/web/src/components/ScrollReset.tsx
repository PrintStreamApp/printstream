/**
 * Resets window scroll to the top when the route pathname changes. SPAs keep the previous
 * page's scroll offset across client-side navigations, so without this a link tapped at the
 * bottom of one page opens the next page mid-scroll. Mounted once per shell (App and
 * MarketingApp); same-page hash/scroll interactions are unaffected because the pathname
 * doesn't change.
 */
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

export function ScrollReset() {
  const { pathname } = useLocation()
  const previousPathnameRef = useRef(pathname)

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return

    previousPathnameRef.current = pathname
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])

  return null
}
