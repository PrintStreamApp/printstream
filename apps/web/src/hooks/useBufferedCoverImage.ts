import { useEffect, useRef, useState } from 'react'
import { resolveBufferedCoverUrl } from '../lib/printerCardMedia'

export function useBufferedCoverImage({
  coverRequestUrl,
  enabled,
  mode,
  treatDisabledAsFailed = false
}: {
  coverRequestUrl: string | null
  enabled: boolean
  mode: 'blob' | 'direct'
  treatDisabledAsFailed?: boolean
}) {
  const objectUrlRef = useRef<string | null>(null)
  const previousCoverRequestUrlRef = useRef<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverLoaded, setCoverLoaded] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)

  useEffect(() => {
    if (!coverRequestUrl && objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setCoverUrl((current) => resolveBufferedCoverUrl({
      currentCoverUrl: current,
      previousCoverRequestUrl: previousCoverRequestUrlRef.current,
      nextCoverRequestUrl: coverRequestUrl
    }))
    previousCoverRequestUrlRef.current = coverRequestUrl
    setCoverLoaded(false)
    setCoverFailed(false)
  }, [coverRequestUrl])

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!coverRequestUrl || !enabled) {
      setCoverLoaded(false)
      setCoverFailed(treatDisabledAsFailed && Boolean(coverRequestUrl))
      return undefined
    }

    let cancelled = false
    let retryTimer: number | null = null
    const controller = new AbortController()

    const loadCover = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (mode === 'blob') {
            const response = await fetch(coverRequestUrl, {
              headers: { Accept: 'image/png,image/*' },
              signal: controller.signal
            })
            if (!response.ok) throw new Error('Cover request failed')
            const blob = await response.blob()
            if (cancelled || controller.signal.aborted) return
            const objectUrl = URL.createObjectURL(blob)
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
            objectUrlRef.current = objectUrl
            setCoverUrl(objectUrl)
          } else {
            const loaded = await new Promise<boolean>((resolve) => {
              const img = new Image()
              img.onload = () => resolve(true)
              img.onerror = () => resolve(false)
              img.src = coverRequestUrl
            })
            if (!loaded) throw new Error('Cover request failed')
            if (cancelled || controller.signal.aborted) return
            setCoverUrl(coverRequestUrl)
          }

          setCoverLoaded(true)
          setCoverFailed(false)
          return
        } catch {
          if (cancelled || controller.signal.aborted) return
          if (attempt === 2) {
            setCoverLoaded(false)
            setCoverFailed(true)
            return
          }
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, 300 * (attempt + 1))
          })
        }
      }
    }

    void loadCover()

    return () => {
      cancelled = true
      controller.abort()
      if (retryTimer != null) window.clearTimeout(retryTimer)
    }
  }, [coverRequestUrl, enabled, mode, treatDisabledAsFailed])

  return { coverUrl, coverLoaded, coverFailed }
}