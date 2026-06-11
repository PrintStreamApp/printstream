# Marketing Screenshot Capture Notes

This document records how the public homepage screenshots in
`apps/web/public/marketing/` were produced so they can be updated or extended
without reverse-engineering the demo state again.

## Source Of Truth

The marketing page reads screenshot metadata from
`apps/web/src/pages/MarketingHomePage.tsx`. The active homepage assets are:

- `printers.jpg` - fleet board hero.
- `printer-detail.jpg` - Studio H2D printer detail view with the full-width loaded camera snapshot.
- `print-dialog.jpg` - dispatch review dialog for Best Shot Golf plate 2 with the yellow first-material mapping and the second slot picker open.
- `slicing-dialog.jpg` - slice dialog for Best Shot Golf plate 2 after slicer details finish loading.
- `preview-3d.jpg` - 3D preview overlay for Best Shot Golf plate 2.
- `library-icon.jpg` - library icon-grid view.
- `library-list.jpg` - library list view.
- `jobs.jpg` - job history view.
- `stats.jpg` - workspace stats view.
- `roles-table.jpg` - workspace roles permission matrix.
- `ams-settings.jpg` - AMS settings dialog.
- `ams-tray-dialog.jpg` - AMS tray detail dialog.
- `skip-object-dialog.jpg` - skip object dialog during an active print.
- `h2d-settings.jpg` - H2D printer settings dialog.
- `printer-controls.jpg` - printer controls dialog.
- `camera.jpg` - printer camera view.

Older or unused assets may still exist in the folder, but they should not be
treated as homepage dependencies unless they are referenced from
`MarketingHomePage.tsx`.

## Demo Runtime Setup

Use the real public demo flow rather than hand-built mock pages. The screenshots
should come from the running app at `http://localhost:5173/` or from the demo
workspace route under `/demo`.

Preferred local startup path:

```sh
npm run dev:demo
```

If the simulator bridge needs to be started manually, run it from the workspace
root with root-relative data paths:

```sh
BRIDGE_NAME='PrintStream Demo Bridge' \
BRIDGE_STATE_FILE=data/demo-bridge-state.json \
BRIDGE_LIBRARY_DIR=data/demo-library \
./node_modules/.bin/tsx watch --include packages/shared/dist/**/*.js apps/bridge/src/demo-index.ts
```

Do not use `../../data/...` paths for the demo bridge. Bridge path resolution is
workspace-root relative, and the wrong path can make the demo fleet appear
offline or empty.

## Capture Guidelines

- Capture from the real demo UI with seeded demo data and the simulator bridge
  online when the required state exists there.
- Sanitize personal user text before saving screenshots. During the original
  capture pass, `Ryan Ewen` was replaced with `Demo Operator`, `Ryan` with
  `Demo`, and `Ewen` with `Operator`.
- Keep images in `apps/web/public/marketing/` as `.jpg` files unless the page
  code changes to reference another format.
- Use full-page captures for normal views so the homepage hover-scroll effect
  has extra vertical content to reveal.
- For dialogs, use bounded clips by default, but use full-page captures when the
  homepage needs the surrounding application context or a taller dialog state.
- For full-page screenshots, if the captured background below the viewport turns
  black or transparent, use a capture-only page background patch. Do not commit
  a persistent app background workaround just to satisfy screenshots.
- Prefer real demo states over visual-only hacks. If a screenshot needs a new
  AMS slot, job state, or stats value, update the demo seed or simulator state
  first and then recapture.

## Suggested Capture Flow

1. Start the API, web app, and demo bridge with `npm run dev:demo`.
2. Open `http://localhost:5173/demo` and confirm the seeded demo tenant loads.
3. Navigate to the exact app surface for the asset being replaced.
4. Start the one-shot screenshot receiver from the repo root:

```sh
npm run capture:marketing:receive -- roles-table.jpg 38780
```

5. Apply capture-only sanitization in the browser context when needed.
6. Post the screenshot bytes from the browser to the receiver URL printed by the
  script, such as `http://127.0.0.1:38780/roles-table.jpg`.
7. Refresh `http://localhost:5173/` and verify the marketing homepage renders
   the updated asset in the product snapshot row.
8. Run the web typecheck after changing page metadata or asset references:

```sh
npm run typecheck --workspace @printstream/web
```

## Full-Page Background Workaround

Some app pages use fixed decorative background layers that only cover the
viewport. A Playwright `fullPage` screenshot then captures the first viewport
with the intended background and the rest of the page with the document fallback
background. For full-page marketing screenshots, apply a capture-only static
background patch before calling `page.screenshot({ fullPage: true })`.

Use this browser-context patch after the target page has loaded and before the
screenshot is taken:

```js
await page.evaluate(() => {
  const background = '#22454b'
  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    document.documentElement.offsetHeight,
    document.body.offsetHeight,
    window.innerHeight
  )

  document.querySelector('[data-marketing-capture-background]')?.remove()
  const backdrop = document.createElement('div')
  backdrop.setAttribute('data-marketing-capture-background', 'true')
  backdrop.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'right:0',
    `height:${pageHeight}px`,
    `background:${background}`,
    'z-index:0',
    'pointer-events:none'
  ].join(';')

  const style = document.createElement('style')
  style.setAttribute('data-marketing-capture', 'full-page-flat-background')
  style.textContent = `
    html,
    body {
      min-height: ${pageHeight}px !important;
      background: ${background} !important;
      background-color: ${background} !important;
      background-image: none !important;
    }
    body {
      position: relative !important;
      isolation: isolate !important;
    }
    #root {
      min-height: ${pageHeight}px !important;
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      position: relative !important;
      z-index: 1 !important;
    }
  `
  document.head.append(style)
  document.body.prepend(backdrop)

  for (const element of Array.from(document.querySelectorAll('body *'))) {
    if (!(element instanceof HTMLElement) || element === backdrop) continue
    const computed = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const isViewportBackdrop =
      computed.position === 'fixed' &&
      computed.backgroundImage !== 'none' &&
      rect.left <= 1 &&
      rect.top <= 1 &&
      rect.width >= window.innerWidth * 0.75 &&
      rect.height >= window.innerHeight * 0.75 &&
      (element.textContent ?? '').trim().length === 0

    if (isViewportBackdrop) element.style.setProperty('display', 'none', 'important')
  }

  window.scrollTo(0, 0)
})
```

The `0.75 * window.innerWidth` tolerance matters: the app background layers can
be slightly narrower than `window.innerWidth` because of scrollbar/layout width,
but they are still the viewport-only decorative layers that need to be hidden.
This is intentionally not an application style change. It is only for capture
sessions and should be rerun each time the browser page reloads.

## Browser Capture Snippet

This is the reusable Playwright shape used with the receiver. Update `receiver`,
`url`, and `waitForSelector` for the asset being captured.

```js
const receiver = 'http://127.0.0.1:38780/roles-table.jpg'
const url = 'http://localhost:5173/workspaces/demo/settings/auth/roles'
const waitForSelector = '#roles table'

await page.setViewportSize({ width: 1350, height: 1000 })
await page.goto(url, { waitUntil: 'networkidle' })
await page.locator(waitForSelector).waitFor({ state: 'visible' })

await page.evaluate(() => {
  const replacements = [[/Ryan Ewen/g, 'Demo Operator'], [/Ryan/g, 'Demo'], [/Ewen/g, 'Operator']]
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    let value = walker.currentNode.nodeValue ?? ''
    for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement)
    walker.currentNode.nodeValue = value
  }
  for (const element of Array.from(document.querySelectorAll('[aria-label]'))) {
    const aria = element.getAttribute('aria-label') ?? ''
    let next = aria
    for (const [pattern, replacement] of replacements) next = next.replace(pattern, replacement)
    element.setAttribute('aria-label', next)
  }
})

// Apply the full-page background workaround here for normal full-page shots.

const buffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true, animations: 'disabled' })
const base64 = buffer.toString('base64')

return await page.evaluate(async ({ receiver, base64 }) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const response = await fetch(receiver, { method: 'POST', body: bytes })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json()
}, { receiver, base64 })
```

For bounded dialog shots, use the same receiver and sanitization flow, but pass a
`clip` rectangle to `page.screenshot()` instead of `fullPage: true`.

## State Notes From The Current Set

- `printers.jpg` expects the demo fleet to show multiple active printers and one
  ready printer.
- `printer-detail.jpg`, `skip-object-dialog.jpg`, `printer-controls.jpg`,
  `h2d-settings.jpg`, `ams-settings.jpg`, and `camera.jpg` were captured from
  the Studio H2D printer detail flow. The current `printer-detail.jpg` uses the
  public demo Studio H2D detail route and should wait for the camera snapshot to
  finish loading before capture.
- `ams-tray-dialog.jpg` uses the Studio H2D AMS A3 Generic PLA slot. The seeded
  fallback and simulator state currently set that slot to Generic PLA.
- `stats.jpg` depends on demo stats/job history seed data being present so the
  view has material and production totals.
- `roles-table.jpg` comes from
  `/workspaces/demo/settings/auth/roles`. It is a full-page capture using the
  static background workaround above and depends on the public demo guest
  retaining read-only auth role visibility.
- `slicing-dialog.jpg` comes from the signed-in library flow for
  `Best Shot Golf.3mf` with `Specific plate` set to `Plate 2` after the slicer
  details finish loading.
- `print-dialog.jpg` comes from the signed-in library flow for
  `Best Shot Golf.gcode.3mf` with `Plate 2` selected, the first filament mapped
  to `A4 Bambu ABS · Tangerine Yellow`, and the second filament menu open.
- `preview-3d.jpg` comes from the signed-in `Best Shot Golf.3mf` slice flow
  after opening the 3D preview overlay for `Plate 2`.

## Adding A New Screenshot

1. Add the image file under `apps/web/public/marketing/`.
2. Add or update the corresponding metadata in `MarketingHomePage.tsx`.
3. Use descriptive alt text that says the image is a sanitized PrintStream demo
   capture.
4. Remove stale assets only after confirming they are not referenced by the
   marketing page or other docs.