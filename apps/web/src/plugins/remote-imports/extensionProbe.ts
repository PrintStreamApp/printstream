const REQUEST_EVENT = 'printstream:remote-import-helper-probe'
const RESPONSE_TYPE = 'printstream-remote-import-helper-presence'

export async function probeRemoteImportHelper(targetWindow: Window = window, timeoutMs = 400): Promise<boolean> {
  if (typeof targetWindow?.addEventListener !== 'function' || typeof targetWindow?.dispatchEvent !== 'function') {
    return false
  }

  const WindowCustomEvent = (targetWindow as Window & { CustomEvent: typeof CustomEvent }).CustomEvent
  const probeId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      targetWindow.removeEventListener('message', handleMessage)
      clearTimeout(timeoutId)
    }
    const finish = (detected: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(detected)
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== targetWindow) return
      if (event.data?.type !== RESPONSE_TYPE) return
      if (event.data?.probeId !== probeId) return
      finish(true)
    }

    const timeoutId = setTimeout(() => finish(false), timeoutMs)
    targetWindow.addEventListener('message', handleMessage)
    targetWindow.dispatchEvent(new WindowCustomEvent(REQUEST_EVENT, {
      detail: { probeId }
    }))
  })
}
