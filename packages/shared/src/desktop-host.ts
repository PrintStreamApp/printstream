/** Versioned, request-only desktop bridge. Native code authorizes the document origin on every call. */
interface DesktopHost {
  version: 1
  /** Optional host-specific additions; absence preserves compatibility with older desktop builds. */
  capabilities?: {
    makerWorldBrowserImport?: boolean
    modelBrowserImport?: readonly ('makerworld' | 'printables')[]
    makerWorldChallengeTest?: boolean
    notifications?: boolean
  }
  request<T>(method: string, options?: unknown): Promise<T>
}

/** Read the browser host without requiring DOM types in the shared package. */
function desktopHost(): DesktopHost | undefined {
  return (globalThis as { window?: { PrintStreamDesktop?: DesktopHost } }).window?.PrintStreamDesktop
}

export function isNativeDesktop(): boolean {
  return desktopHost()?.version === 1
}

/** Electron can capture a user-driven MakerWorld download in its browser session. */
export function supportsDesktopMakerWorldImport(): boolean {
  return supportsDesktopModelBrowserImport('makerworld')
}

/** Whether this desktop build can browse and capture downloads from a provider. */
export function supportsDesktopModelBrowserImport(provider: 'makerworld' | 'printables'): boolean {
  if (!isNativeDesktop()) return false
  const capabilities = desktopHost()?.capabilities
  if (capabilities?.modelBrowserImport?.includes(provider)) return true
  return provider === 'makerworld' && capabilities?.makerWorldBrowserImport === true
}

/** True only when Electron was explicitly launched with its local challenge fixture enabled. */
export function isDesktopMakerWorldChallengeTest(): boolean {
  return supportsDesktopMakerWorldImport() && desktopHost()?.capabilities?.makerWorldChallengeTest === true
}

/** Desktop hosts may explicitly disable notifications while migrating capabilities. */
export function supportsDesktopNotifications(): boolean {
  return isNativeDesktop() && desktopHost()?.capabilities?.notifications !== false
}

/** Unsupported/older hosts fail explicitly; callers hide optional controls when absent. */
export async function desktopRequest<T>(method: string, options?: unknown): Promise<T> {
  if (!isNativeDesktop()) throw new Error('This feature requires the PrintStream desktop app.')
  return desktopHost()!.request<T>(method, options)
}
