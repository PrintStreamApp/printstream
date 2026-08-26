/**
 * State that is ALSO readable synchronously, for surfaces where render and non-render code need the
 * same fact.
 *
 * Owns the setter that writes a `useState` and a caller-supplied `useRef` together. The ref is what
 * code outside the render tree reads -- a pointer handler, an animation loop, a debounced rebuild --
 * because those run between renders and would otherwise close over a stale value; the state is what
 * render and `useMemo` read, because neither can depend on a ref. Callers must not write
 * `ref.current` themselves: the returned setter is the only thing keeping the two in step.
 *
 * The ref is updated SYNCHRONOUSLY, before the re-render React schedules. That ordering is the point
 * -- a caller that sets the value and then immediately runs the non-render path must see the new one.
 *
 * The ref is a PARAMETER rather than something this hook creates, so it stays a direct `useRef()`
 * call at the call site. `react-hooks/exhaustive-deps` recognises only that shape as a stable value;
 * a ref returned from a custom hook is opaque to it, and every callback reading one then draws a
 * false "missing dependency" warning.
 *
 * Extracted after the 3MF editor's hand-rolled version of this pair shipped setters that called
 * THEMSELVES instead of assigning the ref. That type-checks (a function may call itself) and threw
 * only at runtime, as a stack overflow the moment the text tool opened.
 */
import { useCallback, useState, type MutableRefObject } from 'react'

/**
 * @param ref a ref from `useRef(initial)`, kept in step with the returned value.
 * @returns the current value and a stable setter that writes the ref and the state.
 */
export function useMirroredRef<T>(ref: MutableRefObject<T>, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial)
  const set = useCallback((next: T) => {
    ref.current = next
    setValue(next)
  }, [ref])
  return [value, set]
}
