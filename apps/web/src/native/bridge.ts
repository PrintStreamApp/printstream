/**
 * Narrow bridge shared by the hosted web bundle and the Android and desktop wrappers. Keep
 * native capabilities declared here so browser code can detect the host without
 * reaching into Capacitor globals or learning implementation details.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { desktopRequest, isNativeDesktop, supportsDesktopModelBrowserImport } from './desktopBridge'

export type NativeModelProvider = 'makerworld' | 'printables'

export interface PrintStreamInstancePlugin {
  current(): Promise<{ origin: string | null }>
  welcome(): Promise<void>
  enterApp(): Promise<void>
  setConnectionName(options: { name: string | null }): Promise<void>
  signedOut(): Promise<void>
  navigation(options: {
    notificationWorkspaces?: number
    notificationScopes?: Array<{ id: string; name: string; path: string }>
    selfHostedAdmin?: boolean
    destinations: Array<{ name: string; path: string }>
  }): Promise<void>
  menu(options: { view: 'switcher' | 'startup' | 'settings' | 'billing' }): Promise<void>
}

interface ModelBrowserPlugin {
  capabilities(): Promise<{ providers: NativeModelProvider[] }>
  downloadAndImport(options: {
    provider: NativeModelProvider
    modelUrl: string
    workspace: string
    bridgeId: string | null
    folderId: string | null
    defaultFolderName: string
  }): Promise<{ file: unknown; openAfterImport?: 'model-studio' } | { externalOpened: true } | { importUrl: string }>
}

const androidInstance = registerPlugin<PrintStreamInstancePlugin>('PrintStreamInstance')
const androidModelBrowser = registerPlugin<ModelBrowserPlugin>('PrintStreamModelBrowser')

/** Both hosts implement this small connection contract; product UI remains shared. */
export const PrintStreamInstance: PrintStreamInstancePlugin = {
  current: () => isNativeDesktop() ? desktopRequest('current') : androidInstance.current(),
  welcome: () => isNativeDesktop() ? desktopRequest('welcome') : androidInstance.welcome(),
  enterApp: () => isNativeDesktop() ? desktopRequest('enterApp') : androidInstance.enterApp(),
  setConnectionName: (options) => isNativeDesktop() ? desktopRequest('setConnectionName', options) : androidInstance.setConnectionName(options),
  signedOut: () => isNativeDesktop() ? desktopRequest('signedOut') : androidInstance.signedOut(),
  navigation: (options) => isNativeDesktop() ? desktopRequest('navigation', options) : androidInstance.navigation(options),
  menu: (options) => isNativeDesktop() ? desktopRequest('menu', options) : androidInstance.menu(options)
}

export function isNativeApp(): boolean {
  return isNativeAndroid() || isNativeDesktop()
}

/** True only inside the installed Android shell, never the browser/PWA. */
export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/** Discover only providers implemented by this installed native wrapper version. */
export async function nativeModelImportProviders(): Promise<NativeModelProvider[]> {
  if (isNativeDesktop()) {
    return (['makerworld', 'printables'] as const)
      .filter((provider) => supportsDesktopModelBrowserImport(provider))
  }
  if (!isNativeAndroid() || !Capacitor.isPluginAvailable('PrintStreamModelBrowser')) return []
  try {
    const result = await androidModelBrowser.capabilities()
    return result.providers.filter((provider): provider is NativeModelProvider => (
      provider === 'makerworld' || provider === 'printables'
    ))
  } catch {
    return []
  }
}

/** Dispatch a user-driven provider download through the active native host. */
export async function downloadAndImportFromModelProvider(
  options: Parameters<ModelBrowserPlugin['downloadAndImport']>[0]
): Promise<
  { file: unknown; openAfterImport?: 'model-studio' }
  | { externalOpened: true }
  | { importUrl: string }
  | { cancelled: true }
> {
  try {
    if (isNativeDesktop()) return await desktopRequest('modelBrowser.downloadAndImport', options)
    if (!isNativeAndroid() || !Capacitor.isPluginAvailable('PrintStreamModelBrowser')) {
      throw new Error('This installed app does not support model-site browsing.')
    }
    return await androidModelBrowser.downloadAndImport(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/The (MakerWorld|Printables) download was cancelled\./.test(message)) {
      return { cancelled: true }
    }
    throw error
  }
}
