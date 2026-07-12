import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const pwaIconVersion = '20260519a'
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
const sharedSourceEntry = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))
const sharedPrivateSourceEntry = fileURLToPath(new URL('../../packages/shared/src/private/index.ts', import.meta.url))
const sharedPrivateExists = existsSync(sharedPrivateSourceEntry)

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), 'VITE_')
  return {
    cacheDir: '.vite',
    envDir: '../..',
    optimizeDeps: {
      // The model-studio mesh-parse web worker imports three + three-stdlib. Without
      // pre-bundling, dev serves their raw ESM graph (hundreds of modules) into the
      // worker context, which stalls the worker from ever starting here — so the STL/STEP
      // preview hangs until the worker-task timeout falls back to a slow main-thread
      // parse. Pre-bundling them makes the worker load one optimized chunk.
      include: ['three', 'three-stdlib']
    },
    resolve: command === 'serve'
      ? {
          // Entries are prefix-matched in order, so the `/private` subpath
          // must come first or it resolves to `.../index.ts/private`. The
          // private alias only exists on private checkouts (the public
          // export deletes packages/shared/src/private).
          alias: {
            ...(sharedPrivateExists ? { '@printstream/shared/private': sharedPrivateSourceEntry } : {}),
            '@printstream/shared': sharedSourceEntry
          }
        }
      : undefined,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
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
      // Enforce a CSP in dev so the resource directives (notably img/media/connect
      // for camera frames + proxied MJPEG) are exercised here, matching the policy
      // the API serves in production (apps/api/src/lib/content-security-policy.ts).
      // Dev needs the HMR relaxations the prod policy omits: 'unsafe-eval' for the
      // module runtime/react-refresh and ws: for the HMR socket. Camera-relevant
      // directives stay strict so a real camera test is meaningful.
      headers: {
        'Content-Security-Policy': [
          "default-src 'self'",
          "base-uri 'self'",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "form-action 'self'",
          "img-src 'self' data: blob: https://*.paddle.com",
          "media-src 'self' data: blob:",
          "font-src 'self' data:",
          "style-src 'self' 'unsafe-inline' https://*.paddle.com",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.paddle.com https://static.cloudflareinsights.com",
          "connect-src 'self' ws: wss: https://*.paddle.com https://cloudflareinsights.com",
          "frame-src 'self' https://*.paddle.com",
          "worker-src 'self' blob:",
          // The Vite proxy forwards this to the local API's violation sink, so
          // dev violations land in the API log like they do in production.
          'report-uri /api/csp-report'
        ].join('; ')
      },
      // When the dev server runs from source behind a TLS-terminating reverse proxy
      // (e.g. cloudflared → tunnel.printstream.example.com), Vite's host check would reject the
      // proxied Host — allow it via VITE_DEV_ALLOWED_HOSTS (comma-separated).
      allowedHosts: env.VITE_DEV_ALLOWED_HOSTS
        ? env.VITE_DEV_ALLOWED_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
        : undefined,
      // HMR is left to Vite's client inference rather than a forced host/port: the client dials the
      // SAME origin that served the page — ws://localhost:5173 for local access and
      // wss://<proxy-host>(:443) through the tunnel — so BOTH access paths get HMR. The old
      // VITE_DEV_HMR_HOST → { host, protocol:'wss', clientPort:443 } override fixed the tunnel but
      // broke localhost, because one static socket target can't serve both.
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
