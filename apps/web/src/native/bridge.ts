/**
 * Narrow bridge shared by the hosted web bundle and the Android and desktop wrappers. Keep
 * native capabilities declared here so browser code can detect the host without
 * reaching into Capacitor globals or learning implementation details.
 */
import { buildModelImportFileName } from '@printstream/shared'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  desktopPlatform,
  desktopRequest,
  isNativeDesktop,
  supportsDesktopModelBrowserImport,
  supportsDesktopModelImportDestination
} from './desktopBridge'

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

export interface NativeModelDestination {
  bridgeId: string
  folderId: string | null
  /** Editable base name, with the original extension owned by the capture. */
  outputFileName?: string
}

type ChooseModelDestination = (fileName: string) => Promise<NativeModelDestination | null>

declare global {
  interface Window {
    /** Scoped to one user-initiated native import; never installed in provider pages. */
    __printstreamChooseModelDestination?: ChooseModelDestination
  }
}

interface ModelBrowserPlugin {
  capabilities(): Promise<{ providers: NativeModelProvider[]; destinationSelection?: boolean }>
  addListener(event: 'destinationRequested', listener: (event: { requestId: string; fileName: string }) => void): Promise<PluginListenerHandle>
  completeDestination(options: { requestId: string; cancelled?: boolean; bridgeId?: string; folderId?: string | null; fileName?: string }): Promise<void>
  downloadAndImport(options: {
    provider: NativeModelProvider
    modelUrl: string
    resume?: boolean
    workspace: string
    bridgeId: string | null
    folderId: string | null
    defaultFolderName: string
    promptForDestination: true
  }): Promise<{ file: unknown; openAfterImport?: 'model-studio' } | { externalOpened: true } | { importUrl: string }>
}

interface CapacitorAppPlugin {
  getInfo(): Promise<{ version: string }>
}

export interface NativeAppBuild {
  label: string
  version: string
}

const androidInstance = registerPlugin<PrintStreamInstancePlugin>('PrintStreamInstance')
const androidModelBrowser = registerPlugin<ModelBrowserPlugin>('PrintStreamModelBrowser')
const androidApp = registerPlugin<CapacitorAppPlugin>('App')

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

/** Returns the installed wrapper's identity, separate from the connected server build. */
export async function nativeAppBuild(): Promise<NativeAppBuild | null> {
  if (isNativeDesktop()) {
    const version = await desktopRequest<string>('app.version')
    return { label: desktopAppLabel(desktopPlatform()), version }
  }
  if (isNativeAndroid()) {
    const { version } = await androidApp.getInfo()
    return { label: 'Android app', version }
  }
  return null
}

function desktopAppLabel(platform: ReturnType<typeof desktopPlatform>): string {
  if (platform === 'win32') return 'Windows app'
  if (platform === 'darwin') return 'macOS app'
  return 'Linux app'
}

/** Discover only providers implemented by this installed native wrapper version. */
export async function nativeModelImportProviders(): Promise<NativeModelProvider[]> {
  if (isNativeDesktop()) {
    if (!supportsDesktopModelImportDestination()) return []
    return (['makerworld', 'printables'] as const)
      .filter((provider) => supportsDesktopModelBrowserImport(provider))
  }
  if (!isNativeAndroid() || !Capacitor.isPluginAvailable('PrintStreamModelBrowser')) return []
  try {
    const result = await androidModelBrowser.capabilities()
    if (!result.destinationSelection) return []
    return result.providers.filter((provider): provider is NativeModelProvider => (
      provider === 'makerworld' || provider === 'printables'
    ))
  } catch {
    return []
  }
}

/** Dispatch a user-driven provider download through the active native host. */
export async function downloadAndImportFromModelProvider(
  options: Parameters<ModelBrowserPlugin['downloadAndImport']>[0],
  chooseDestination: ChooseModelDestination
): Promise<
  { file: unknown; openAfterImport?: 'model-studio' }
  | { externalOpened: true }
  | { importUrl: string }
  | { cancelled: true }
> {
  let listener: PluginListenerHandle | null = null
  if (window.__printstreamChooseModelDestination) throw new Error('A model browser is already open.')
  const chooseCapturedDestination = async (fileName: string) => {
    const destination = await chooseDestination(fileName)
    if (!destination) return null
    return { ...destination, fileName: buildModelImportFileName(fileName, destination.outputFileName) }
  }
  window.__printstreamChooseModelDestination = chooseCapturedDestination
  try {
    if (isNativeDesktop()) return await desktopRequest('modelBrowser.downloadAndImport', options)
    if (!isNativeAndroid() || !Capacitor.isPluginAvailable('PrintStreamModelBrowser')) {
      throw new Error('This installed app does not support model-site browsing.')
    }
    listener = await androidModelBrowser.addListener('destinationRequested', (event) => {
      void (async () => {
        let destination: Awaited<ReturnType<typeof chooseCapturedDestination>> = null
        try {
          destination = await chooseCapturedDestination(event.fileName)
        } finally {
          await androidModelBrowser.completeDestination({
            requestId: event.requestId,
            ...(destination ?? { cancelled: true })
          })
        }
      })().catch((error) => { console.warn('Could not reply to the model destination request', error) })
    })
    return await androidModelBrowser.downloadAndImport(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/The (MakerWorld|Printables) download was cancelled\./.test(message)) {
      return { cancelled: true }
    }
    throw error
  } finally {
    delete window.__printstreamChooseModelDestination
    await listener?.remove()
  }
}
