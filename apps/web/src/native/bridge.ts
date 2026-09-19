/**
 * Narrow bridge shared by the hosted web bundle and the Android and Windows wrappers. Keep
 * native capabilities declared here so browser code can detect the host without
 * reaching into Capacitor globals or learning implementation details.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { desktopRequest, isNativeWindows } from './desktopBridge'

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

const androidInstance = registerPlugin<PrintStreamInstancePlugin>('PrintStreamInstance')

/** Both hosts implement this small connection contract; product UI remains shared. */
export const PrintStreamInstance: PrintStreamInstancePlugin = {
  current: () => isNativeWindows() ? desktopRequest('current') : androidInstance.current(),
  welcome: () => isNativeWindows() ? desktopRequest('welcome') : androidInstance.welcome(),
  enterApp: () => isNativeWindows() ? desktopRequest('enterApp') : androidInstance.enterApp(),
  setConnectionName: (options) => isNativeWindows() ? desktopRequest('setConnectionName', options) : androidInstance.setConnectionName(options),
  signedOut: () => isNativeWindows() ? desktopRequest('signedOut') : androidInstance.signedOut(),
  navigation: (options) => isNativeWindows() ? desktopRequest('navigation', options) : androidInstance.navigation(options),
  menu: (options) => isNativeWindows() ? desktopRequest('menu', options) : androidInstance.menu(options)
}

export function isNativeApp(): boolean {
  return isNativeAndroid() || isNativeWindows()
}

/** True only inside the installed Android shell, never the browser/PWA. */
export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}
