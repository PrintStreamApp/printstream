/**
 * Client-side STL/STEP preview thumbnails for core library rows.
 *
 * STL and STEP files have no embedded image, so the model-studio plugin renders a
 * small iso-framed snapshot on the client and hands it to core's `FileThumbnail`
 * through the model thumbnail registry. Both are fetched as binary STL from `/mesh`
 * (the server tessellates STEP to STL first), so the renderer only ever parses STL.
 * This module is loaded lazily (dynamic `import()` from the plugin's init hook) so
 * Three.js stays out of the initial bundle until the first preview is asked for.
 *
 * Results are cached per file revision (id + uploadedAt) and fetch/parse work is
 * concurrency-limited so a library page full of STL files doesn't stampede the
 * network or main thread. A single offscreen WebGL renderer is reused for every
 * snapshot.
 *
 * Each fresh render is also uploaded (best-effort) to `PUT /api/library/:id/thumbnail`,
 * which persists it server-side. That makes the render a once-per-file-version cost: the
 * next view — for this client or any other — is served the stored PNG straight from
 * `FileThumbnail`'s `<img>`, with no mesh fetch, STEP tessellation, or WebGL render.
 */
import * as THREE from 'three'
import type { LibraryFile } from '@printstream/shared'
import { buildApiUrl } from '../../../lib/apiUrl'
import { readWorkspaceContextHeader } from '../../../lib/workspaceContext'
import { parseStlGeometry } from './threeMfScene'

const THUMBNAIL_SIZE = 256
const MAX_CONCURRENT = 3
const MAX_CACHE_ENTRIES = 240

/**
 * Mesh color for raw STL/STEP renders. Exported so the interactive 3D preview
 * (`PreviewView`) shows the same color as these list thumbnails.
 */
export const MESH_PREVIEW_COLOR = 0x9db4d0

/**
 * Camera *position* direction (front-left, Z-up) for the snapshot. Unlike the
 * plate thumbnail's 45° iso view, this sits at ~30° elevation: a shallower angle
 * keeps horizontal faces edge-on so a model's flat base reads as a base, not as
 * a build plate you're looking down onto. (-0.612, -0.612, 0.5) is a unit vector
 * at azimuth 225° / elevation 30°.
 */
const STL_VIEW_DIRECTION = new THREE.Vector3(-0.612, -0.612, 0.5)

const cache = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

function cacheKey(file: LibraryFile): string {
  return `${file.id}:${file.uploadedAt}`
}

// Limit concurrent fetch+parse work. The slot is handed directly to the next
// waiter on release so the active count never dips between queued jobs.
let active = 0
const waiters: Array<() => void> = []
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => waiters.push(resolve))
}
function release(): void {
  const next = waiters.shift()
  if (next) {
    next()
  } else {
    active -= 1
  }
}

interface StlRenderer {
  render(geometry: THREE.BufferGeometry): string
  dispose(): void
}

let renderer: StlRenderer | null = null

// Idle release: the singleton renderer holds a live WebGL context (contexts count against
// the browser's ~8-16 live-context cap and hold GPU memory), so drop it after the library
// view has gone quiet instead of keeping it for the whole session. The next thumbnail
// request just recreates it.
const RENDERER_IDLE_DISPOSE_MS = 60_000
let rendererIdleTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRendererIdleDispose(): void {
  if (rendererIdleTimer) clearTimeout(rendererIdleTimer)
  rendererIdleTimer = setTimeout(() => {
    rendererIdleTimer = null
    renderer?.dispose()
    renderer = null
  }, RENDERER_IDLE_DISPOSE_MS)
}

function getRenderer(): StlRenderer {
  if (renderer) return renderer

  const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  gl.setPixelRatio(1)
  gl.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
  gl.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5d646b, 1.1))
  const dir = new THREE.DirectionalLight(0xffffff, 0.6)
  dir.position.set(1, -1, 1.4)
  scene.add(dir)

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 6000)
  camera.up.set(0, 0, 1)

  const material = new THREE.MeshStandardMaterial({ color: MESH_PREVIEW_COLOR, metalness: 0.1, roughness: 0.6 })
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  scene.add(mesh)

  renderer = {
    render(geometry) {
      mesh.geometry = geometry
      geometry.computeBoundingBox()
      const box = geometry.boundingBox ?? new THREE.Box3()
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const radius = Math.max(size.x, size.y, size.z, 1) * 0.62

      camera.left = -radius
      camera.right = radius
      camera.top = radius
      camera.bottom = -radius
      const distance = radius * 8
      camera.position.set(
        center.x + distance * STL_VIEW_DIRECTION.x,
        center.y + distance * STL_VIEW_DIRECTION.y,
        center.z + distance * STL_VIEW_DIRECTION.z
      )
      camera.near = 0.1
      camera.far = distance * 4
      camera.lookAt(center)
      camera.updateProjectionMatrix()

      gl.render(scene, camera)
      scheduleRendererIdleDispose()
      return gl.domElement.toDataURL('image/png')
    },
    dispose() {
      material.dispose()
      gl.dispose()
      // Free the context deterministically; dispose() alone waits for canvas GC.
      gl.forceContextLoss()
    }
  }
  return renderer
}

function tenantHeaders(): Record<string, string> {
  const workspaceContext = readWorkspaceContextHeader()
  return workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {}
}

async function fetchStlBytes(fileId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(buildApiUrl(`/api/library/${encodeURIComponent(fileId)}/mesh`), {
    method: 'GET',
    credentials: 'include',
    headers: tenantHeaders(),
    signal
  })
  if (!response.ok) {
    throw new Error(`Unable to load STL mesh (${response.status}).`)
  }
  return response.arrayBuffer()
}

function rememberThumbnail(key: string, url: string): void {
  cache.set(key, url)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * Persist a freshly rendered snapshot so later views are served the stored PNG instead
 * of re-rendering. Best-effort and detached from the caller's signal: a failed (or
 * raced) upload just means the next viewer renders again. `v=uploadedAt` lets the server
 * drop a render of a now-superseded version rather than caching stale content.
 */
function uploadRenderedThumbnail(file: LibraryFile, dataUrl: string): void {
  void (async () => {
    try {
      // Decode the data URL by hand: `fetch(dataUrl)` counts as a connect-src request,
      // which the app's CSP blocks — that silently disabled thumbnail persistence
      // everywhere CSP is enforced (the render succeeded, the PUT never happened, and
      // every later view re-rendered from scratch).
      const comma = dataUrl.indexOf(',')
      const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (char) => char.charCodeAt(0))
      const png = new Blob([bytes], { type: 'image/png' })
      await fetch(
        buildApiUrl(`/api/library/${encodeURIComponent(file.id)}/thumbnail?v=${encodeURIComponent(file.uploadedAt)}`),
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'image/png', ...tenantHeaders() },
          body: png
        }
      )
    } catch {
      // Best-effort cache warming; ignore failures.
    }
  })()
}

/**
 * Render (or return a cached) PNG data URL preview for a raw-mesh library file — STL,
 * STEP, or a geometry-only 3MF (all served as STL by `/mesh`). Resolves to `null` when
 * the preview can't be produced (aborted, fetch/parse failure) so callers fall back to
 * the kind label.
 */
export async function renderMeshThumbnail(file: LibraryFile, signal?: AbortSignal): Promise<string | null> {
  if (file.kind !== 'stl' && file.kind !== 'step' && !(file.kind === '3mf' && file.geometryOnly === true)) return null
  const key = cacheKey(file)
  const cached = cache.get(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const job = (async (): Promise<string | null> => {
    await acquire()
    try {
      if (signal?.aborted) return null
      const bytes = await fetchStlBytes(file.id, signal)
      if (signal?.aborted) return null
      const geometry = parseStlGeometry(bytes)
      try {
        const url = getRenderer().render(geometry)
        rememberThumbnail(key, url)
        uploadRenderedThumbnail(file, url)
        return url
      } finally {
        geometry.dispose()
      }
    } catch {
      return null
    } finally {
      release()
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, job)
  return job
}
