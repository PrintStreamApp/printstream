/**
 * Shared interactive orientation gizmo ("view cube") for the model-studio
 * plugin, reused by both the read-only `PreviewView` and the interactive
 * `EditorView`.
 *
 * Owns the canonical Bambu-style view presets (iso/front/back/left/right/top/
 * bottom), the helpers that turn a preset into a camera direction/up, the ortho
 * frame-radius math used to fit plated content, and `createViewCube`, a small
 * factory that builds the secondary WebGL renderer + clickable cube and returns
 * handles to sync its orientation, dispose it, and react to face clicks.
 *
 * Keep this free of React/plugin coupling so it stays a pure rendering toolkit.
 */
import * as THREE from 'three'
import { createWebglRenderer } from './webglRenderer'

export const BAMBU_THREE_MF_ISO_VIEW = { x: -0.5, y: -0.5, z: Math.SQRT1_2 } as const
export const BAMBU_THREE_MF_ISO_UP = { x: 0, y: 0, z: 1 } as const
/**
 * The editor's default "home" camera direction, a slightly-elevated **front** view
 * (no left/right rotation), distinct from the iso corner view. Shared so the read-only
 * G-code preview can open at the same angle the full editor does. Consumers normalize it
 * and scale by their own view distance; the up vector is {@link BAMBU_THREE_MF_ISO_UP}.
 */
export const EDITOR_HOME_VIEW_DIRECTION = { x: 0, y: -0.55, z: 1 } as const
export const BAMBU_THREE_MF_ORTHO_MARGIN = 1.04
export const VIEW_CUBE_SIZE = 92

/**
 * Distance from the viewport's left and bottom edges, in px, the SAME on both, so the cube sits
 * squarely in the corner. It used to be nudged out of frame at xs (-18) to hide the transparent
 * margin the old wide frustum baked into the canvas; the canvas now hugs the cube, so this is a
 * real inset and matches the 8px the toolbar keeps from the top-right.
 */
export const VIEW_CUBE_EDGE_INSET = 8

export type ViewPreset = 'iso' | 'front' | 'rear' | 'left' | 'right' | 'top' | 'bottom'

/**
 * Which view each face of the cube MESH shows, in `BoxGeometry`'s material order: +X, -X, +Y, -Y,
 * +Z, -Z in the cube's OWN local space.
 *
 * Read that order carefully, because it is the thing that makes the cube's local axes different
 * from the world's: local +Y is Top (world +Z) and local +Z is Front (world -Y). Anything placed on
 * the cube by a world-space direction has to be rotated into this frame first -- see
 * {@link viewCubeLocalSign}, and the bug in its header.
 */
export const VIEW_CUBE_FACE_PRESETS: Array<Exclude<ViewPreset, 'iso'>> = [
  'right',
  'left',
  'top',
  'bottom',
  'front',
  'rear'
]

export const VIEW_CUBE_FACE_LABELS: Record<Exclude<ViewPreset, 'iso'>, string> = {
  front: 'Front',
  rear: 'Rear',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom'
}

/**
 * How far the straight-down views lean, so their screen orientation is defined.
 *
 * A camera looking along world Z with world Z as its up vector has no resolvable orientation --
 * `lookAt` degenerates. The old fix was to hand Top and Bottom an up vector of their own,
 * `(0, 1, 0)`, but `OrbitControls` measures its polar angle from `object.up`, so that silently
 * re-based every later drag onto a different axis: picking a face changed how the camera BEHAVED
 * rather than only where it sat. Leaning the DIRECTION a hair instead resolves `lookAt` the same
 * way while leaving the orbit frame on world Z. At any real view distance this is well under a
 * pixel, and it is chosen to put +Y at the top of the screen, which is the conventional top view
 * and the one Studio's own `up` produced.
 */
const STRAIGHT_DOWN_VIEW_LEAN = 1e-3

export const VIEW_PRESET_CONFIG: Record<
  ViewPreset,
  {
    direction: { x: number; y: number; z: number }
    /**
     * Which way is UP ON SCREEN for this view. Read by the ortho framing maths; NOT written to
     * `camera.up`, which stays world Z so every preset orbits in the same frame.
     */
    up: { x: number; y: number; z: number }
  }
> = {
  iso: {
    direction: { ...BAMBU_THREE_MF_ISO_VIEW },
    up: { ...BAMBU_THREE_MF_ISO_UP }
  },
  front: {
    direction: { x: 0, y: -1, z: 0 },
    up: { x: 0, y: 0, z: 1 }
  },
  rear: {
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
    direction: { x: 0, y: -STRAIGHT_DOWN_VIEW_LEAN, z: 1 },
    up: { x: 0, y: 1, z: 0 }
  },
  bottom: {
    // The lean points the SAME way as Top's, which is what makes going between them a TIP rather
    // than a spin. Leaning the other way (Studio's choice, since its Bottom shares Top's `up`) puts
    // both views' screen-up on +Y, and the rotation between them is then 180 degrees about world Y
    // -- the screen's VERTICAL axis, so the model whirls about it like a revolving door. Matching
    // the lean makes it 180 degrees about world X instead, the screen's horizontal axis, which is
    // the model tipping toward you to show its underside. A deliberate divergence: Studio snaps
    // between views, so it never has to look at the motion between them.
    direction: { x: 0, y: -STRAIGHT_DOWN_VIEW_LEAN, z: -1 },
    up: { x: 0, y: -1, z: 0 }
  }
}

/**
 * One clickable patch of the cube: a face, an edge, or a corner.
 *
 * The cube's surface is tiled as a 3x3 grid per face, which is what every CAD view cube does and
 * what yields exactly 6 + 12 + 8 = 26 regions from one rule. A region's direction is simply the
 * sign vector of the cell it occupies, so an edge looks along two faces at once and a corner along
 * three -- no table of angles to keep in step with the face list.
 */
export interface ViewCubeRegion {
  /** Sign vector, -1 / 0 / +1 per axis, never all zero. */
  readonly sign: readonly [number, number, number]
  /** Where the camera goes, as an offset from the target. Normalized. */
  readonly direction: { readonly x: number; readonly y: number; readonly z: number }
  /** The named preset for the six face cells; null for edges and corners. */
  readonly preset: Exclude<ViewPreset, 'iso'> | null
  /** Human label, e.g. "Top", "Top front", "Top front right". */
  readonly label: string
}

/**
 * Half-thickness of the edge/corner band as a fraction of the cube. 0.22 leaves a 0.56 face cell,
 * which keeps the labelled centre comfortably the biggest target while making the edges wide enough
 * to hit on a touch screen.
 */
const VIEW_CUBE_BAND = 0.22

/** Which face each axis sign names. +X right, +Y back, +Z top, matching {@link VIEW_PRESET_CONFIG}. */
const AXIS_FACE_LABELS: Record<number, [string, string]> = {
  0: ['Left', 'Right'],
  1: ['Front', 'Rear'],
  2: ['Bottom', 'Top']
}

function regionLabel(sign: readonly [number, number, number]): string {
  // Z first, then Y, then X, so a corner reads "Top front right" rather than "Right front top".
  const parts: string[] = []
  for (const axis of [2, 1, 0]) {
    const value = sign[axis]!
    if (value !== 0) parts.push(AXIS_FACE_LABELS[axis]![value > 0 ? 1 : 0]!)
  }
  return parts.map((part, index) => (index === 0 ? part : part.toLowerCase())).join(' ')
}

function facePresetFor(sign: readonly [number, number, number]): Exclude<ViewPreset, 'iso'> | null {
  const nonZero = sign.filter((value) => value !== 0)
  if (nonZero.length !== 1) return null
  if (sign[0] !== 0) return sign[0]! > 0 ? 'right' : 'left'
  if (sign[1] !== 0) return sign[1]! > 0 ? 'rear' : 'front'
  return sign[2]! > 0 ? 'top' : 'bottom'
}

/** Every clickable region of the cube, in a stable order. */
export const VIEW_CUBE_REGIONS: readonly ViewCubeRegion[] = (() => {
  const regions: ViewCubeRegion[] = []
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (x === 0 && y === 0 && z === 0) continue
        const sign = [x, y, z] as const
        const preset = facePresetFor(sign)
        // A face cell takes its direction from the preset table rather than from its own sign, so
        // the straight-down lean that keeps `lookAt` resolvable is not lost here.
        const raw = preset
          ? VIEW_PRESET_CONFIG[preset].direction
          : { x, y, z }
        const length = Math.hypot(raw.x, raw.y, raw.z)
        regions.push({
          sign,
          direction: { x: raw.x / length, y: raw.y / length, z: raw.z / length },
          preset,
          label: regionLabel(sign)
        })
      }
    }
  }
  return regions
})()

/**
 * World sign vector of the cube's own local +X, +Y and +Z axes.
 *
 * DERIVED from {@link VIEW_CUBE_FACE_PRESETS} rather than written out, so it cannot disagree with
 * the faces actually rendered: material index 0 is local +X, index 2 is local +Y and index 4 is
 * local +Z, and each names the view its face shows. `Math.round` drops the sub-millimetre lean the
 * straight-down directions carry, leaving a clean axis.
 */
const CUBE_LOCAL_AXES_IN_WORLD: ReadonlyArray<readonly [number, number, number]> = [0, 2, 4].map((materialIndex) => {
  const { direction } = VIEW_PRESET_CONFIG[VIEW_CUBE_FACE_PRESETS[materialIndex]!]
  return [Math.round(direction.x), Math.round(direction.y), Math.round(direction.z)] as const
})

/**
 * Turn a WORLD sign vector into the cube's own local frame.
 *
 * The two frames are a signed axis permutation apart, not the same frame, and skipping this is a
 * bug with no visible symptom on the six faces: a face lands on its own axis either way, so the
 * cube looks perfectly correct while every EDGE and CORNER is wrong. Measured, the top-front edge
 * sat where top-back belonged, and clicking it swung the camera behind the plate.
 *
 * Safe because the permutation is orthonormal: projecting onto each local axis recovers the local
 * component exactly, and zero components stay zero, so a face stays a face and an edge an edge.
 */
export function viewCubeLocalSign(sign: readonly [number, number, number]): [number, number, number] {
  return CUBE_LOCAL_AXES_IN_WORLD.map((axis) =>
    sign[0]! * axis[0] + sign[1]! * axis[1] + sign[2]! * axis[2]
  ) as [number, number, number]
}

/**
 * Ease a 0..1 progress so a camera swing leaves and arrives gently.
 *
 * Cubic in and out. Linear reads as mechanical at this duration -- the camera starts at full speed,
 * which is the jarring part a swing exists to remove.
 */
export function easeViewTween(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress))
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2
}

/** The orientation a camera at `direction` from its target has, with world Z as its up vector. */
export function viewOrientationFor(direction: { x: number; y: number; z: number }): THREE.Quaternion {
  const eye = new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(eye, new THREE.Vector3(), new THREE.Vector3(0, 0, 1))
  )
}

/**
 * The camera ORIENTATION part-way through a swing, from which the caller derives its position.
 *
 * Interpolating the whole orientation is what keeps the motion readable. Interpolating only the
 * DIRECTION and letting `lookAt` recompute the roll each frame looks fine across the middle of the
 * sphere and falls apart at the poles, where a fractional change of direction swings the up vector
 * through a large angle: the camera appears to snap round mid-swing. Reported going from Top to
 * Bottom, which is the worst case, being exactly antipodal.
 *
 * A quaternion slerp also takes the SHORTEST path by construction, so the roll is the least it can
 * be rather than whatever axis a direction-only rotation happened to pick.
 *
 * `progress` is raw 0..1; the easing is applied here so callers cannot forget it.
 */
export function viewTweenOrientationAt(
  from: THREE.Quaternion,
  to: THREE.Quaternion,
  progress: number
): THREE.Quaternion {
  return from.clone().slerp(to, easeViewTween(progress))
}

/**
 * Where a camera sits given its orientation, the point it looks at, and how far off it should be.
 *
 * The camera's own +Z axis points from the target back to it, so this is exactly consistent with
 * the orientation: it looks straight at `target` at every step of a swing, with no separate
 * position interpolation that could disagree, and at a constant radius so the model cannot loom.
 */
export function viewPositionFor(
  orientation: THREE.Quaternion,
  target: THREE.Vector3,
  distance: number
): THREE.Vector3 {
  return target.clone().addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(orientation), distance)
}

/** The region diametrically opposite this one: the view from the other side. */
export function oppositeViewCubeRegion(region: ViewCubeRegion): ViewCubeRegion {
  // Joined and compared as text on purpose: negating a zero component gives -0, which is not `0`
  // under a strict numeric comparison but does print as "0".
  const wanted = region.sign.map((value) => -value).join(',')
  // Every sign vector has its negation in the set (the 26 cells are symmetric about the centre),
  // so this cannot miss; the fallback keeps the signature total rather than asserting.
  return VIEW_CUBE_REGIONS.find((candidate) => candidate.sign.join(',') === wanted) ?? region
}

/**
 * What the cube can do, in one place so every host shows the same words.
 *
 * All three gestures are invisible without it: nothing about a cube suggests that its edges are
 * targets, that a second click flips you to the far side, or that Shift keeps where you were
 * looking instead of recentring.
 */
export const VIEW_CUBE_HINT =
  'Click a face, edge or corner to look from it. Double-click for the opposite side. Shift-click to keep your pan and zoom.'

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
 * The half-extent radius an orthographic camera needs to frame a box of `size` from a given view
 * direction, at the given aspect ratio.
 *
 * Takes a direction rather than a preset because an EDGE or CORNER of the cube names no preset, so
 * there is no `up` to look up and world Z stands in. A direction parallel to the up hint degenerates
 * the cross product and falls back below, which is what makes the straight-down cases safe here
 * without a special case.
 */
export function computeOrthoFrameRadiusForDirection(
  size: THREE.Vector3,
  aspect: number,
  direction: { x: number; y: number; z: number },
  upHintSource: { x: number; y: number; z: number } = { x: 0, y: 0, z: 1 }
): number {
  const forward = new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
  const upHint = new THREE.Vector3(upHintSource.x, upHintSource.y, upHintSource.z).normalize()
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
 * Build the secondary view-cube renderer inside `container` and wire its interaction.
 *
 * `onSelect` fires for any of the 26 {@link VIEW_CUBE_REGIONS}: the six labelled faces, the twelve
 * edges, and the eight corners. Edges and corners matter more than they look -- the editor's home
 * view is a raised front angle, and before they existed there was no way to click back to anything
 * like it, only to a flat-on face.
 *
 * The cube mirrors the main camera each `sync()` call, and repaints itself on hover, since nothing
 * else drives its render loop.
 */
export interface ViewCubeSelection {
  /** The view to move to: the region clicked, or its opposite on a double-click. */
  readonly region: ViewCubeRegion
  /**
   * Whether to re-centre on the bed at the default distance as well as turning.
   *
   * True for a plain click, which is what makes a face double as "reset the view". Shift holds the
   * current pan and zoom, so you can turn around whatever you had zoomed in on.
   */
  readonly reframe: boolean
}

export function createViewCube(
  container: HTMLElement,
  onSelect: (selection: ViewCubeSelection) => void
): ViewCubeHandle {
  const renderer = createWebglRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(VIEW_CUBE_SIZE, VIEW_CUBE_SIZE)
  renderer.setClearColor(0x000000, 0)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.cursor = 'pointer'
  container.replaceChildren(renderer.domElement)

  const scene = new THREE.Scene()
  // Frames the unit cube tightly: its furthest corner is at sqrt(3)/2 ~= 0.866 from centre, so
  // 0.95 never clips at ANY orientation while leaving almost no transparent margin. The old 1.45
  // wasted ~27% of the canvas on each side, which read as the cube floating away from the corner
  // however the container was positioned.
  const camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 20)
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

  /**
   * Invisible pick volumes tiling the cube's surface, one per region.
   *
   * Picking these rather than the visible box is what makes edges and corners selectable at all: a
   * raycast against the box yields only a `materialIndex`, which can name a face and nothing finer.
   * They are `visible = false` so they never render, which does NOT stop `Raycaster` finding them.
   */
  const pickRegions = new THREE.Group()
  const regionByObject = new Map<THREE.Object3D, ViewCubeRegion>()
  const cell = (value: number) => (value === 0 ? 1 - 2 * VIEW_CUBE_BAND : VIEW_CUBE_BAND)
  const offset = (value: number) => (value === 0 ? 0 : value * (0.5 - VIEW_CUBE_BAND / 2))
  for (const region of VIEW_CUBE_REGIONS) {
    // The cube's frame, not the world's -- see `viewCubeLocalSign`.
    const [sx, sy, sz] = viewCubeLocalSign(region.sign)
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(cell(sx), cell(sy), cell(sz)),
      new THREE.MeshBasicMaterial()
    )
    pick.position.set(offset(sx), offset(sy), offset(sz))
    pick.visible = false
    pickRegions.add(pick)
    regionByObject.set(pick, region)
  }
  group.add(pickRegions)

  /**
   * The hover affordance: one box moved to whichever region is under the pointer. Reusing a single
   * mesh keeps this free of the per-hover scene churn that would otherwise run on every mouse move.
   * It is scaled a hair past the cube so it reads as a highlight ON the surface rather than a panel
   * floating inside it, and it keeps depth testing so a region on the far side stays hidden.
   */
  const highlight = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.34, toneMapped: false })
  )
  highlight.visible = false
  group.add(highlight)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const frontViewQuaternion = createViewQuaternion('front')
  let hovered: ViewCubeRegion | null = null

  const regionAt = (event: PointerEvent): ViewCubeRegion | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(pickRegions.children, false)[0]
    return hit ? regionByObject.get(hit.object) ?? null : null
  }

  const setHovered = (region: ViewCubeRegion | null) => {
    if (region === hovered) return
    hovered = region
    if (region) {
      const [sx, sy, sz] = viewCubeLocalSign(region.sign)
      // Grow only along the axes the region FACES, so a highlighted edge stays an edge instead of
      // swelling into the neighbouring faces.
      const grow = (value: number, size: number) => (value === 0 ? size : size + 0.06)
      highlight.scale.set(grow(sx, cell(sx)), grow(sy, cell(sy)), grow(sz, cell(sz)))
      highlight.position.set(offset(sx), offset(sy), offset(sz))
    }
    highlight.visible = region !== null
    renderer.render(scene, camera)
  }

  /**
   * Second click on the same region within this counts as a double.
   *
   * The first click is NOT delayed waiting to find out. Deferring every single click by a
   * double-click window would put the wait on the common gesture to serve the rare one, and at this
   * size the cube is mostly used for single clicks. The cost is that a double-click starts the
   * swing toward the near side before reversing -- but the reversal picks up from wherever the
   * camera has reached rather than jumping, so it reads as changing its mind rather than glitching.
   */
  const DOUBLE_CLICK_MS = 400
  let lastClick: { region: ViewCubeRegion; at: number } | null = null

  const handlePointerDown = (event: PointerEvent) => {
    const region = regionAt(event)
    if (!region) return
    const at = performance.now()
    const isDouble = lastClick !== null && lastClick.region === region && at - lastClick.at < DOUBLE_CLICK_MS
    // Cleared after a double so a third click starts a fresh gesture rather than flip-flopping.
    lastClick = isDouble ? null : { region, at }
    onSelect({
      region: isDouble ? oppositeViewCubeRegion(region) : region,
      reframe: !event.shiftKey
    })
  }
  const handlePointerMove = (event: PointerEvent) => setHovered(regionAt(event))
  const handlePointerLeave = () => setHovered(null)
  renderer.domElement.addEventListener('pointerdown', handlePointerDown)
  renderer.domElement.addEventListener('pointermove', handlePointerMove)
  renderer.domElement.addEventListener('pointerleave', handlePointerLeave)

  return {
    domElement: renderer.domElement,
    sync(mainCamera: THREE.Camera) {
      group.quaternion.copy(mainCamera.quaternion).invert().multiply(frontViewQuaternion)
      renderer.render(scene, camera)
    },
    dispose() {
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('pointermove', handlePointerMove)
      renderer.domElement.removeEventListener('pointerleave', handlePointerLeave)
      scene.remove(group)
      group.traverse((child) => {
        const disposable = child as THREE.Object3D & {
          geometry?: THREE.BufferGeometry
          material?: THREE.Material | THREE.Material[]
        }
        disposable.geometry?.dispose()
        const materials = Array.isArray(disposable.material) ? disposable.material : disposable.material ? [disposable.material] : []
        for (const material of materials) {
          // Free the face CanvasTextures too: Material.dispose() doesn't release `.map`.
          for (const value of Object.values(material as unknown as Record<string, unknown>)) {
            if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose()
          }
          material.dispose()
        }
      })
      renderer.dispose()
      // dispose() alone leaves the WebGL context alive until the canvas is garbage-
      // collected; browsers cap live contexts (~8-16) and evict the OLDEST when the cap
      // is hit, which kills an unrelated healthy viewer. Release it deterministically.
      renderer.forceContextLoss()
    }
  }
}
