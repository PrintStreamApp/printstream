/**
 * Decides whether this page owns a PWA service worker. A Capacitor host loads a
 * fresh bundle from the selected server and uses native FCM for background work,
 * so registering the PWA worker there creates two update/notification owners.
 */
export function shouldManageAppServiceWorker(input: { devMode: boolean; nativeAndroid: boolean }): boolean {
  return !input.devMode && !input.nativeAndroid
}
