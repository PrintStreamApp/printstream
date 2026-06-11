/**
 * Client-side STL preview thumbnails for core library rows.
 *
 * STL files have no embedded image and the API ships no 3D renderer, so the
 * model-previewer plugin renders a small iso-framed snapshot on the client and
 * hands it to core's `FileThumbnail` through the STL thumbnail registry. This
 * module is loaded lazily (dynamic `import()` from the plugin's init hook) so
 * Three.js stays out of the initial bundle until the first STL preview is asked
 * for.
 *
 * Results are cached per file revision (id + uploadedAt) and fetch/parse work is
 * concurrency-limited so a library page full of STL files doesn't stampede the
 * network or main thread. A single offscreen WebGL renderer is reused for every
 * snapshot.
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
}

let renderer: StlRenderer | null = null

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

  const material = new THREE.MeshStandardMaterial({ color: 0x9db4d0, metalness: 0.1, roughness: 0.6 })
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
      return gl.domElement.toDataURL('image/png')
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
 * Render (or return a cached) PNG data URL preview for an STL library file.
 * Resolves to `null` when the preview can't be produced (aborted, fetch/parse
 * failure) so callers fall back to the kind label.
 */
export async function renderStlThumbnail(file: LibraryFile, signal?: AbortSignal): Promise<string | null> {
  if (file.kind !== 'stl') return null
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
