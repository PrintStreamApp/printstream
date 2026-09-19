/**
 * One notification form for all memberships on the current origin. Account and
 * membership changes cancel stale work; workspace navigation does not re-prompt.
 */
import { useEffect, useRef, useState } from 'react'
import { extractErrorMessage, nativeNotificationAccount, type AuthBootstrap } from '@printstream/shared'
import { isAppBusy, subscribeAppBusy } from '../../lib/appBusy'
import { disableNativeNotifications, enableNativeNotifications, hasNativeNotifications, readNativeNotificationScope } from '../../native/notifications'
import { notificationScopes, notificationSelectionKey, type NotificationScope } from '../../native/notificationScopes'
import { finishAppNotificationSettings, hasAppNotificationSettingsRequest, notificationSettingsChanged, requestedAppNotificationScope, subscribeAppNotificationSettings, takeAppNotificationSettingsRequest } from '../../native/appSettings'
import { dismissMobileNotificationOffer, isMobileNotificationOfferDismissed, notificationScopeOfferKey } from './prompt'
import { startOfferLifecycle } from './offerLifecycle'

const defaultServices = {
  supported: hasNativeNotifications,
  read: readNativeNotificationScope,
  enable: enableNativeNotifications,
  disable: disableNativeNotifications,
  start: startOfferLifecycle
}
export interface NotificationChoice extends NotificationScope {
  enabled: boolean
  permission: boolean
  available: boolean
  selected: boolean
}

/** Failed rows remain retryable; successful rows are retained so retries do not duplicate enrollment. */
export function useMobileNotificationOffer(bootstrap: AuthBootstrap | undefined, services = defaultServices) {
  const key = services.supported() ? notificationSelectionKey(bootstrap) : null
  const latest = useRef(bootstrap)
  latest.current = bootstrap
  const currentKey = useRef(key)
  currentKey.current = key
  const [choices, setChoices] = useState<NotificationChoice[]>([])
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const saving = useRef(false)
  const openRef = useRef(false)

  useEffect(() => {
    const epoch = ++generation.current
    const controller = new AbortController()
    const snapshot = latest.current
    const active = () => generation.current === epoch && currentKey.current === key && !controller.signal.aborted
    setOpenKey(null)
    openRef.current = false
    setChoices([])
    setBusy(false)
    setLoading(false)
    setError(null)
    saving.current = false
    if (!key || !snapshot) return () => controller.abort()

    async function load(isManual: boolean, signal: AbortSignal) {
      const loaded: NotificationChoice[] = []
      const requestedScope = isManual ? requestedAppNotificationScope() : null
      // Reads never request Android permission. Serialize native account selection.
      for (const scope of notificationScopes(snapshot)) {
        if (!active() || signal.aborted) return false
        const state = await services.read(scope.bootstrap, signal)
        const offered = isMobileNotificationOfferDismissed(notificationScopeOfferKey(nativeNotificationAccount(snapshot)!, scope.id))
        loaded.push({
          ...scope,
          ...state,
          selected: state.enabled || requestedScope === scope.id || (!isManual && !offered && state.available)
        })
      }
      if (!active() || signal.aborted || (isManual ? !openRef.current : openRef.current)) return false
      setChoices(loaded)
      setManual(isManual)
      return isManual || loaded.some((choice) => choice.selected && !choice.enabled)
    }

    const run = services.start({
      async ready(signal) {
        if (openRef.current || isMobileNotificationOfferDismissed(key)) return false
        return load(false, signal)
      },
      offer() {
        if (!active() || openRef.current) return
        openRef.current = true
        setOpenKey(key)
      },
      isBusy: isAppBusy,
      subscribeIdle: subscribeAppBusy,
      subscribeResume(listener) {
        const resume = () => { if (document.visibilityState === 'visible') listener() }
        document.addEventListener('visibilitychange', resume)
        window.addEventListener('online', listener)
        return () => {
          document.removeEventListener('visibilitychange', resume)
          window.removeEventListener('online', listener)
        }
      },
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
    })
    let loading = false
    const showSettings = () => {
      if (openRef.current) return
      openRef.current = true
      setOpenKey(key)
      setManual(true)
      setError(null)
      if (loading) return
      loading = true
      setLoading(true)
      setChoices([])
      run.dispose()
      void (async () => {
        try {
          if (await load(true, controller.signal)) {
            takeAppNotificationSettingsRequest()
            openRef.current = true
            setOpenKey(key)
            setError(null)
          }
        } catch (caught) {
          if (active() && openRef.current) {
            setManual(true)
            openRef.current = true
            setOpenKey(key)
            setError(extractErrorMessage(caught))
          }
        } finally {
          loading = false
          if (active()) setLoading(false)
        }
      })()
    }
    const unsubscribe = subscribeAppNotificationSettings(showSettings)
    if (hasAppNotificationSettingsRequest()) showSettings()
    return () => {
      controller.abort()
      run.dispose()
      unsubscribe()
      generation.current = epoch + 1
    }
  }, [key, services])

  function dismiss() {
    if (!key || saving.current) return
    takeAppNotificationSettingsRequest()
    dismissMobileNotificationOffer(key)
    rememberOfferedScopes()
    openRef.current = false
    setOpenKey(null)
    void finishAppNotificationSettings().catch(() => { console.warn("Could not return to app settings.") })
  }

  async function enable() {
    if (!key || openKey !== key || saving.current || loading) return
    const epoch = generation.current
    const active = () => generation.current === epoch && currentKey.current === key
    saving.current = true
    setBusy(true)
    setError(null)
    const failures: string[] = []
    try {
      for (const choice of choices) {
        if (!active()) return
        if (choice.selected === choice.enabled && (!choice.selected || choice.permission)) continue
        try {
          if (choice.selected) await services.enable(choice.bootstrap, active)
          else await services.disable(choice.bootstrap, active)
          if (!active()) return
          setChoices((previous) => previous.map((row) => row.id === choice.id
            ? { ...row, enabled: choice.selected, permission: choice.selected || row.permission } : row))
        } catch (caught) {
          if (!active()) return
          failures.push(choice.name + ': ' + extractErrorMessage(caught))
          // Permission belongs to the app, not each workspace. A denial must
          // not trigger another Android prompt for every remaining checkbox.
          if (caught && typeof caught === 'object' && 'code' in caught && caught.code === 'NOTIFICATIONS_BLOCKED') {
            setChoices((previous) => previous.map((row) => ({ ...row, permission: false })))
            break
          }
        }
      }
      if (!active()) return
      if (failures.length) setError(failures.join('\n'))
      else {
        dismissMobileNotificationOffer(key)
        rememberOfferedScopes()
        openRef.current = false
        setOpenKey(null)
        await finishAppNotificationSettings()
      }
    } catch (caught) {
      if (active()) {
        openRef.current = true
        setOpenKey(key)
        setError(extractErrorMessage(caught))
      }
    } finally {
      if (active()) {
        notificationSettingsChanged()
        saving.current = false
        setBusy(false)
      }
    }
  }

  function select(id: string, selected: boolean) {
    if (saving.current) return
    setChoices((previous) => previous.map((choice) => choice.id === id ? { ...choice, selected } : choice))
  }

  /** Remember only displayed scopes, never a newly arrived membership outside this form. */
  function rememberOfferedScopes() {
    for (const choice of choices) {
      dismissMobileNotificationOffer(notificationScopeOfferKey(nativeNotificationAccount(choice.bootstrap)!, choice.id))
    }
  }

  return { open: Boolean(key && openKey === key), choices, manual, busy, loading, error, dismiss, enable, select }
}
