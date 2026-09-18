/**
 * Return destinations for native public-page excursions. Only known product and
 * onboarding paths can be remembered; never store auth codes or arbitrary URLs.
 * Session storage survives the document navigations between the app's shells.
 */
const RETURN_KEY = 'printstream.native.returnPath'

/** Keep only local product/onboarding paths, dropping query strings and fragments. */
export function nativeReturnPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\%\s]/.test(value)) return null
  const pathname = value.split(/[?#]/, 1)[0] ?? ''
  if (/^\/workspaces(?:\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_/-]+)?)?$/.test(pathname)) return pathname
  if (/^\/(?:platform|billing\/[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)*$/.test(pathname)) return pathname
  if (pathname === '/register' || pathname === '/get-started' || pathname === '/billing') return pathname
  return null
}

/** Remember the last product/onboarding screen, without retaining credentials. */
export function rememberNativeReturnPath(pathname: string): void {
  const path = nativeReturnPath(pathname)
  if (!path) return
  try { sessionStorage.setItem(RETURN_KEY, path) } catch { /* Navigation works without storage. */ }
}

/** Info pages return to their caller; onboarding itself can always return to welcome. */
export function readNativeReturnPath(currentPath: string): string | null {
  if (nativeReturnPath(currentPath)) return null
  try { return nativeReturnPath(sessionStorage.getItem(RETURN_KEY) ?? '') } catch { return null }
}

/** Clear excursion history when returning to the native chooser, not the login session. */
export function clearNativeReturnPath(): void {
  try { sessionStorage.removeItem(RETURN_KEY) } catch { /* Best effort. */ }
}
