# Public web assets

This folder holds the files the web app serves as they are: the PWA install icons used by the web manifest, the browser favicon and the iOS home-screen icon, the in-app wordmark (`logo.svg`), and the unmodified official Google Play and Microsoft Store distribution badges.

The icons (`icon.svg`, `icon-192.png`, `icon-512.png`, `maskable-icon-*.png`, `apple-touch-icon.png`) are generated from the masters in `assets/brand/` by `npm run icons`; edit the master, not these files (`assets/brand/README.md`). `icon-1024.png` predates the generator and is not one of its outputs.
