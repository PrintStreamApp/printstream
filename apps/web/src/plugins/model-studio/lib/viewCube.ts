/**
 * Shared interactive orientation gizmo ("view cube") for the model-studio
 * plugin, reused by both the read-only `PreviewView` and the interactive
 * `EditorView`.
 *
 * Owns the canonical Bambu-style view presets (iso/front/back/left/right/top/
 * bottom), the helpers that turn a preset into a camera direction/up, the ortho
 * frame-radius math used to fit plated content, and `createViewCube` — a small
 * factory that builds the secondary WebGL renderer + clickable cube and returns
 * handles to sync its orientation, dispose it, and react to face clicks.
 *
 * Keep this free of React/plugin coupling so it stays a pure rendering toolkit.
 */
import * as THREE from 'three'

export const BAMBU_THREE_MF_ISO_VIEW = { x: -0.5, y: -0.5, z: Math.SQRT1_2 } as const
export const BAMBU_THREE_MF_ISO_UP = { x: 0, y: 0, z: 1 } as const
/**
 * The editor's default "home" camera direction — a slightly-elevated **front** view
 * (no left/right rotation), distinct from the iso corner view. Shared so the read-only
 * G-code preview can open at the same angle the full editor does. Consumers normalize it
 * and scale by their own view distance; the up vector is {@link BAMBU_THREE_MF_ISO_UP}.
 */
export const EDITOR_HOME_VIEW_DIRECTION = { x: 0, y: -0.55, z: 1 } as const
export const BAMBU_THREE_MF_ORTHO_MARGIN = 1.04
export const VIEW_CUBE_SIZE = 136

export type ViewPreset = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'

export const VIEW_CUBE_FACE_PRESETS: Array<Exclude<ViewPreset, 'iso'>> = [
  'right',
  'left',
  'top',
  'bottom',
  'front',
  'back'
]

export const VIEW_CUBE_FACE_LABELS: Record<Exclude<ViewPreset, 'iso'>, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom'
}

export const VIEW_PRESET_CONFIG: Record<
  ViewPreset,
  { direction: { x: number; y: number; z: number }; up: { x: number; y: number; z: number } }
> = {
  iso: {
    direction: { ...BAMBU_THREE_MF_ISO_VIEW },
    up: { ...BAMBU_THREE_MF_ISO_UP }
  },
  front: {
    direction: { x: 0, y: -1, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  back: {
    direction: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  left: {
    direction: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  right: {
    direction: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  top: {
    direction: { x: 0, y: 0, z: 1 },
    up: { x: 0, y: 1, z: 0 }
  },
  bottom: {
    direction: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 }
  }
}

/** Quaternion that orients the cube so a given preset faces the camera. */
export function createViewQuaternion(preset: ViewPreset): THREE.Quaternion {
  const config = VIEW_PRESET_CONFIG[preset]
  const eye = new THREE.Vector3(config.direction.x, config.direction.y, config.direction.z)
  const target = new THREE.Vector3(0, 0, 0)
  const up = new THREE.Vector3(config.up.x, config.up.y, config.up.z)
  const matrix = new THREE.Matrix4().lookAt(eye, target, up)
  return new THREE.Quaternion().setFromRotationMatrix(matrix)
}

function createViewCubeFaceMaterial(label: string): THREE.MeshBasicMaterial {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 160
  const context = canvas.getContext('2d')
  if (!context) {
    return new THREE.MeshBasicMaterial({ color: 0x16243a, toneMapped: false })
  }

  context.fillStyle = '#13233a'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#7fb8ff'
  context.lineWidth = 10
  context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16)
  context.fillStyle = '#e4efff'
  context.font = '700 30px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, canvas.width / 2, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
}

/**
 * Compute the half-extent radius needed for an orthographic camera to frame a
 * box of `size` from a given preset direction at the given aspect ratio.
 */
export function computePlatedOrthoFrameRadius(size: THREE.Vector3, aspect: number, preset: ViewPreset): number {
  const config = VIEW_PRESET_CONFIG[preset]
  const forward = new THREE.Vector3(config.direction.x, config.direction.y, config.direction.z).normalize()
  const upHint = new THREE.Vector3(config.up.x, config.up.y, config.up.z).normalize()
  const right = new THREE.Vector3().crossVectors(upHint, forward)
  if (right.lengthSq() < 1e-8) {
    right.set(1, 0, 0)
  } else {
    right.normalize()
  }
  const up = new THREE.Vector3().crossVectors(forward, right).normalize()
  const halfSize = size.clone().multiplyScalar(0.5)
  const horizontalHalfExtent =
    Math.abs(right.x) * halfSize.x + Math.abs(right.y) * halfSize.y + Math.abs(right.z) * halfSize.z
  const verticalHalfExtent =
    Math.abs(up.x) * halfSize.x + Math.abs(up.y) * halfSize.y + Math.abs(up.z) * halfSize.z

  if (aspect >= 1) {
    return Math.max(verticalHalfExtent, horizontalHalfExtent / aspect) * BAMBU_THREE_MF_ORTHO_MARGIN
  }

  return Math.max(horizontalHalfExtent, verticalHalfExtent * aspect) * BAMBU_THREE_MF_ORTHO_MARGIN
}

/** Handles returned by `createViewCube` for syncing, click handling, and teardown. */
export interface ViewCubeHandle {
  /** The secondary renderer's canvas (already appended into the container). */
  readonly domElement: HTMLCanvasElement
  /** Re-orient the cube to mirror the main camera and render one frame. */
  sync(mainCamera: THREE.Camera): void
  /** Release renderer/GPU resources and detach the click listener. */
  dispose(): void
}

/**
 * Build the secondary view-cube renderer inside `container` and wire a face-click
 * handler. `onSelectPreset` fires when a labelled cube face is clicked. The cube
 * mirrors the main camera each `sync()` call.
 */
export function createViewCube(
  container: HTMLElement,
  onSelectPreset: (preset: Exclude<ViewPreset, 'iso'>) => void
): ViewCubeHandle {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(VIEW_CUBE_SIZE, VIEW_CUBE_SIZE)
  renderer.setClearColor(0x000000, 0)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.cursor = 'pointer'
  container.replaceChildren(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1.45, 1.45, 1.45, -1.45, 0.1, 20)
  camera.position.set(0, 0, 6)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  scene.add(new THREE.AmbientLight(0xffffff, 1.1))
  const light = new THREE.DirectionalLight(0xdfeeff, 0.7)
  light.position.set(2.4, 2.8, 3.2)
  scene.add(light)

  const materials = VIEW_CUBE_FACE_PRESETS.map((preset) => createViewCubeFaceMaterial(VIEW_CUBE_FACE_LABELS[preset]))
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const mesh = new THREE.Mesh(geometry, materials)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xa8c8ff, transparent: true, opacity: 0.82 })
  )
  const group = new THREE.Group()
  group.add(mesh)
  group.add(edges)
  scene.add(group)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const frontViewQuaternion = createViewQuaternion('front')

  const handlePointerDown = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(mesh, false)[0]
    const materialIndex = hit?.face?.materialIndex
    if (typeof materialIndex !== 'number') return
    const preset = VIEW_CUBE_FACE_PRESETS[materialIndex]
    if (!preset) return
    onSelectPreset(preset)
  }
  renderer.domElement.addEventListener('pointerdown', handlePointerDown)

  return {
    domElement: renderer.domElement,
    sync(mainCamera: THREE.Camera) {
      group.quaternion.copy(mainCamera.quaternion).invert().multiply(frontViewQuaternion)
      renderer.render(scene, camera)
    },
    dispose() {
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      scene.remove(group)
      group.traverse((child) => {
        const disposable = child as THREE.Object3D & {
          geometry?: THREE.BufferGeometry
          material?: THREE.Material | THREE.Material[]
        }
        disposable.geometry?.dispose()
        if (Array.isArray(disposable.material)) {
          disposable.material.forEach((material) => material.dispose())
        } else {
          disposable.material?.dispose()
        }
      })
      renderer.dispose()
    }
  }
}
