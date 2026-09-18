/** Versioned, request-only Windows bridge. Native code authorizes the document origin on every call. */
interface DesktopHost {
  version: 1
  request<T>(method: string, options?: unknown): Promise<T>
}

/** Read the browser host without requiring DOM types in the shared package. */
function desktopHost(): DesktopHost | undefined {
  return (globalThis as { window?: { PrintStreamDesktop?: DesktopHost } }).window?.PrintStreamDesktop
}

export function isNativeWindows(): boolean {
  return desktopHost()?.version === 1
}

/** Unsupported/older hosts fail explicitly; callers hide optional controls when absent. */
export async function desktopRequest<T>(method: string, options?: unknown): Promise<T> {
  if (!isNativeWindows()) throw new Error('This feature requires the PrintStream Windows app.')
  return desktopHost()!.request<T>(method, options)
}
