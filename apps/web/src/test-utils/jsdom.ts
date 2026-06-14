/**
 * Shared jsdom bootstrap for web component tests.
 *
 * Every Joy UI render test needs the same ~35 lines: a JSDOM instance plus a pile of globals
 * (`window`, `document`, `HTMLElement`, `matchMedia`, rAF shims, …) assigned onto `globalThis`. This
 * centralises that so suites only declare what is *different* (their URL, a dynamic `matchMedia`
 * matcher) and add any extra globals they need (`fetch`, `confirm`, …) after calling it.
 *
 * Call it from a `before()` hook and close the returned dom in `after()`:
 *
 *   let dom: JSDOM
 *   before(() => { dom = installJsdomGlobals({ url: 'http://localhost/account' }) })
 *   after(() => { dom.window.close() })
 */
import { JSDOM } from 'jsdom'

export interface InstallJsdomOptions {
  /** Document URL (sets `window.location`). Defaults to `http://localhost/`. */
  url?: string
  /** Returns `matchMedia(query).matches`. Defaults to always `false`. */
  matchMedia?: (query: string) => boolean
}

export function installJsdomGlobals(options: InstallJsdomOptions = {}): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: options.url ?? 'http://localhost/' })
  const { window } = dom
  const matches = options.matchMedia ?? (() => false)

  const matchMedia = (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false }
  })

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle)
  })

  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: matchMedia })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia })
  // Harmless no-op several layouts call on mount; always provided so callers don't each redefine it.
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: () => {} })

  return dom
}
