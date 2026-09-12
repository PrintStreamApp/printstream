/**
 * What devkit cannot derive about THIS repo: its ports, the environment its dev servers read, and
 * the checks only it knows to make.
 *
 * Everything else (how this checkout is named, which database it gets, how it is proxied, how a new
 * worktree is seeded) lives in the shared package and is identical for every project on the
 * machine. See https://github.com/RyanEwen/devkit.
 *
 * Counterpart: `scripts/dev/run-dev.mjs`, the only caller of `preflight()`.
 */
import { inspectSlicerSource } from './scripts/dev/slicer-image.mjs'

/** Fixed listeners inside every checkout container; Compose receives these through `env()`. */
export const DEV_PORTS = Object.freeze({
  api: '4000',
  metrics: '4001',
  slicer: '4010',
  web: '5173'
})

export default {
  /**
   * Order matters: these are offsets within this checkout's derived block, so reordering moves
   * every service to a different port. `web` first makes it the block's base, which is the one the
   * proxy routes to and therefore the one worth being stable.
   */
  ports: ['web'],

  /** Pin the PostgreSQL server version this project expects. */
  database: { engine: 'postgres', version: '16.13-bookworm' },

  /** Prisma, so `devkit doctor` can report how far this checkout's database has been migrated. */
  migrationsTable: '_prisma_migrations',

  /**
   * Captured alongside the database so a new worktree starts with a usable library rather than
   * rows pointing at files that are not there. `LIBRARY_DIR` defaults to `./data/library`, a
   * CHECKOUT-RELATIVE path, which is what makes the two halves have to travel together.
   *
   * `bridge-state.json` carries the durable `installationId` the API re-binds a returning bridge
   * by, so a copy without it orphans every library file from its owner. Separate databases mean the
   * duplicated id never collides between checkouts. `data/exports` is deliberately excluded: it is
   * regenerable and roughly 52 MB.
   */
  baselinePaths: [
    'data/library',
    'data/job-history-thumbnails',
    'data/job-history-snapshots',
    'data/plugins',
    'data/bridge-state.json',
    'data/hms-codes.json',
    'data/hms-codes.01S.json'
  ],

  /**
   * Git does not carry ignored files into a linked worktree, but this one is required by the API,
   * bridge, tests and Prisma commands. Devkit copies it from the primary checkout on first start;
   * an existing worktree `.env` always wins, so a branch remains free to customise its own values.
   */
  worktreeFiles: ['.env'],

  /** Open the proxied UI only when the API and its database are ready for requests. */
  browser: { path: '/', healthPath: '/api/health/ready' },

  /**
   * Everything here is a value the app already reads from its environment; devkit adds no new
   * configuration surface to the app itself.
   *
   * `CLIENT_ORIGIN` is the PROXIED origin rather than the direct port because it is what the
   * browser actually addresses, and the configured authentication provider derives its relying
   * party identity from that hostname.
   */
  env: ({ url, identity, configDir }) => ({
    API_PORT: DEV_PORTS.api,
    METRICS_PORT: DEV_PORTS.metrics,
    CLIENT_ORIGIN: url,
    BRIDGE_SERVER_URL: `http://localhost:${DEV_PORTS.api}`,
    VITE_DEV_PORT: DEV_PORTS.web,
    VITE_API_PORT: DEV_PORTS.api,
    SLICER_PORT: DEV_PORTS.slicer,
    /** A container-absolute default (run-dev.mjs's) would not exist on the host. */
    SLICER_DATA_ROOT: process.env.SLICER_DATA_ROOT || `${configDir}/slicer`,
    SLICER_WORK_DIR: process.env.SLICER_WORK_DIR || `${configDir}/slicer-work/${identity.slug}`
  }),

  /**
   * The slicer runs as a container built from this checkout, which nothing else on the machine
   * knows about, so its staleness is this project's to report rather than devkit's.
   */
  checks: [
    ({ repoRoot, identity }) => {
      const source = inspectSlicerSource({
        repoRoot,
        composeProject: identity.composeProject,
        imageRef: `${identity.composeProject}-slicer`
      })
      if (source.state === 'matches') {
        return {
          label: 'slicer source',
          detail: 'the local image matches your slicer source'
        }
      }

      if (source.state === 'not-running') return { label: 'slicer', detail: 'no slicer container running (in-process slicer, or none)' }
      if (source.state === 'not-built') {
        return {
          label: 'slicer image',
          detail: 'this checkout has no local slicer image',
          fix: 'npm run dev'
        }
      }
      if (source.state === 'differs') {
        return {
          state: '!',
          label: 'slicer source',
          detail: `${source.reason}: the local image predates it`,
          fix: 'npm run dev'
        }
      }
      return { state: '!', label: 'slicer source', detail: `cannot tell: ${source.reason}` }
    }
  ]
}
