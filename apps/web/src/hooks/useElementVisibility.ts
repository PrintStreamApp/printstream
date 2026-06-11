import { useEffect, useState, type RefObject } from 'react'

/**
 * Track whether an element is currently in the viewport.
 */
export function useElementVisibility<T extends Element>(
  ref: RefObject<T | null>,
  enabled: boolean,
  threshold = 0.25
): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setVisible(false)
      return
    }

    const element = ref.current
    if (!element) {
      setVisible(false)
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry?.isIntersecting ?? false)
      },
      { threshold }
    )

    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [enabled, ref, threshold])

  return visible
}