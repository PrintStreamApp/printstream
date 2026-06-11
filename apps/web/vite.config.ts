import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const pwaIconVersion = '20260519a'
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
const sharedSourceEntry = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), 'VITE_')
  const domainMigrationTarget = env.VITE_DOMAIN_MIGRATION_TARGET?.trim() ?? ''
  const migrationModeEnabled = domainMigrationTarget.length > 0

  return {
    cacheDir: '.vite',
    envDir: '../..',
    resolve: command === 'serve'
      ? {
          alias: {
            '@printstream/shared': sharedSourceEntry
          }
        }
      : undefined,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        selfDestroying: migrationModeEnabled,
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/ws(?:\/|$)/],
          skipWaiting: true,
          // Pulled in verbatim by the generated service worker. Adds the
          // `push` and `notificationclick` listeners used by the
          // notifications-browser plugin.
          importScripts: ['/push-handler.js']
        },
        manifest: {
          name: 'PrintStream',
          short_name: 'PrintStream',
          description: 'Mobile-friendly companion app for Bambu Lab printers.',
          theme_color: '#0d1322',
          background_color: '#070b14',
          display: 'standalone',
          start_url: '/workspaces',
          id: '/',
          icons: [
            {
              src: `/icon-192.png?v=${pwaIconVersion}`,
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: `/icon-512.png?v=${pwaIconVersion}`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: `/maskable-icon-192.png?v=${pwaIconVersion}`,
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable'
            },
            {
              src: `/maskable-icon-512.png?v=${pwaIconVersion}`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            }
          ]
        }
      })
    ],
    server: {
      port: 5173,
      host: true,
      // When the dev server runs from source behind a TLS-terminating reverse proxy
      // (e.g. dev.printstream.app via nginx + Cloudflare), Vite's host check would
      // reject the proxied Host and its HMR client would dial the wrong origin/port.
      // Both are opt-in via env so local `npm run dev` is unaffected:
      //   VITE_DEV_ALLOWED_HOSTS=dev.printstream.app   (comma-separated)
      //   VITE_DEV_HMR_HOST=dev.printstream.app        (HMR over wss on :443)
      allowedHosts: env.VITE_DEV_ALLOWED_HOSTS
        ? env.VITE_DEV_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
        : undefined,
      hmr: env.VITE_DEV_HMR_HOST
        ? { host: env.VITE_DEV_HMR_HOST, protocol: 'wss', clientPort: 443 }
        : undefined,
      fs: {
        allow: [workspaceRoot]
      },
      proxy: {
        // The bridge-runtime connection is a long-lived WebSocket under /api, so it
        // needs an explicit ws proxy entry (listed first, most-specific) — without it
        // a home/LAN bridge pointed at a from-source dev origin can't connect.
        '/api/bridge-runtime/connect': { target: 'ws://localhost:4000', ws: true },
        '/api': { target: 'http://localhost:4000' },
        '/ws': { target: 'ws://localhost:4000', ws: true }
      }
    }
  }
})
