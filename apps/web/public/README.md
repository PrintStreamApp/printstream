# Public web assets.

This folder includes the generated PWA install icons used by the web manifest,
browser favicon, iOS home-screen install flow, push notifications, and the
unmodified official Google Play and Microsoft Store distribution badges.

The generated PNG assets in this folder are exported from `icon.svg` for the default app icon and `maskable-icon.svg` for Android launcher-safe maskable icons.
To regenerate them, render the SVG in a browser, capture the SVG element itself, and write the
normalized square PNGs from that render. The SVGs stay the source of truth. An `export:web-icons`
script used to rasterise them with ImageMagick instead; it was removed because it contradicted that
rule (see the web development notes), which is the one to follow.
