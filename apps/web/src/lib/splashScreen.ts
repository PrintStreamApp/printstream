/**
 * Drives the boot splash screen rendered in index.html: updates its progress bar
 * and status text, then completes and fades it out, enforcing a minimum visible
 * duration so a fast boot doesn't flash. Operates directly on the `app-splash`
 * DOM nodes and no-ops when they are absent. Module-level state tracks the start
 * time and a single scheduled completion; reset only via the test helper.
 */
const COMPLETE_CLASS = 'is-complete'
const HIDDEN_CLASS = 'is-hidden'
const MIN_VISIBLE_MS = 500
const HIDE_DELAY_MS = 240

let splashScreenStartedAt: number | null = null
let completionScheduled = false

export function setSplashScreenProgress(progressPercent: number, status: string): void {
  const splash = getSplashRoot()
  if (!splash) return

  ensureSplashScreenStartedAt()

  const clamped = clampProgress(progressPercent)
  splash.style.setProperty('--app-splash-progress', `${clamped}%`)

  const percentNode = document.getElementById('app-splash-percent')
  if (percentNode) percentNode.textContent = `${clamped}%`

  const statusNode = document.getElementById('app-splash-status')
  if (statusNode) statusNode.textContent = status
}

export function completeSplashScreen(): void {
  const splash = getSplashRoot()
  if (!splash || splash.classList.contains(COMPLETE_CLASS) || completionScheduled) return

  const startedAt = ensureSplashScreenStartedAt()
  completionScheduled = true
  const remainingVisibleMs = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt))

  window.setTimeout(() => {
    setSplashScreenProgress(100, 'App ready')
    splash.classList.add(COMPLETE_CLASS)

    window.setTimeout(() => {
      document.body?.classList.add('app-boot-ready')
      splash.classList.add(HIDDEN_CLASS)
    }, HIDE_DELAY_MS)
  }, remainingVisibleMs)
}

/**
 * Reveal #root and remove the boot splash instantly (no minimum-visible delay). Used for a light
 * marketing cold load so the app-boot splash ("Loading the app…") never dwells on a marketing page.
 */
export function dismissSplashScreenImmediately(): void {
  completionScheduled = true
  document.body?.classList.add('app-boot-ready')
  const splash = getSplashRoot()
  if (splash) splash.classList.add(COMPLETE_CLASS, HIDDEN_CLASS)
}

/**
 * Re-show the boot splash after it was dismissed — e.g. when the user enters the app from a marketing
 * page and the heavy app chunk has to load. {@link completeSplashScreen} hides it again once ready.
 */
export function showSplashScreen(): void {
  const splash = getSplashRoot()
  // Leave an already-visible splash alone (e.g. a normal cold app-route load) so its timing isn't reset.
  const alreadyVisible =
    !document.body?.classList.contains('app-boot-ready') &&
    !(splash?.classList.contains(COMPLETE_CLASS) || splash?.classList.contains(HIDDEN_CLASS))
  if (alreadyVisible) return

  completionScheduled = false
  splashScreenStartedAt = Date.now()
  // Clear the pre-bundle marketing flag too, or the index.html CSS would keep the splash hidden when
  // entering the app from a marketing page.
  document.documentElement.classList.remove('ps-marketing-boot')
  document.body?.classList.remove('app-boot-ready')
  if (splash) splash.classList.remove(COMPLETE_CLASS, HIDDEN_CLASS)
}

export function resetSplashScreenStateForTests(): void {
  splashScreenStartedAt = null
  completionScheduled = false
}

function ensureSplashScreenStartedAt(): number {
  if (splashScreenStartedAt == null) {
    const splash = getSplashRoot()
    const startedAt = splash?.dataset.startedAt ? Number(splash.dataset.startedAt) : Number.NaN
    splashScreenStartedAt = Number.isFinite(startedAt) ? startedAt : Date.now()
  }
  return splashScreenStartedAt
}

function getSplashRoot(): HTMLElement | null {
  return document.getElementById('app-splash')
}

function clampProgress(progressPercent: number): number {
  const rounded = Math.round(progressPercent)
  return Math.max(0, Math.min(100, rounded))
}