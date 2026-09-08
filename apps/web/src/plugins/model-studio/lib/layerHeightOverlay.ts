/**
 * Showing a variable layer-height profile ON the model, rather than only on a bar beside it.
 *
 * Why this exists: BambuStudio's thickness bar is legible because it sits against a model shaded by
 * layer height. Porting the bar without the shading gives a strip with nothing to anchor it to, so a
 * drag lands somewhere the user cannot see.
 *
 * **The colour is computed PER FRAGMENT, from the fragment's world Z.** This is the whole design,
 * and the reason for the shader injection below. The obvious implementation, a vertex-colour
 * attribute, cannot work here: a box wall is two triangles spanning the object's entire height, so
 * its only colour samples are its corners, and a 2mm brush band at mid-height has nowhere to be
 * stored. It gets linearly interpolated across the whole face instead, which is why the first two
 * attempts were reported as "a blur of highlight" and "lots of shading and glowing areas". Per
 * fragment, a band is exact on any mesh, however coarse.
 *
 * The colours live in a 1D lookup texture sampled by height, with NEAREST filtering so a zone
 * boundary is a hard edge rather than a ramp. Recolouring is therefore a few hundred texel writes
 * regardless of how dense the model is, which is what makes it cheap enough to run on every pointer
 * sample of a brush stroke.
 *
 * **The overlay is LIT.** An unlit material paints one flat colour per height and erases every
 * shading cue, so the model stops looking like a model and becomes a glowing silhouette. It lights
 * like an ordinary part and carries the profile as its base colour.
 *
 * **Zones, not a gradient.** Heights bucket onto {@link LAYER_HEIGHT_CHANGE_STEP}, Studio's own
 * smallest layer-height step, so the model shows flat bands with boundaries where the profile
 * actually changes thickness. A continuous ramp encodes the same data with an edge nowhere, so
 * nothing in it looks like a layer. A true per-LAYER stripe is not an option at any resolution we
 * have: a 35mm model at 0.08mm is over 400 layers, finer than the pixels its silhouette occupies.
 */
import * as THREE from 'three'
import { LAYER_HEIGHT_CHANGE_STEP, layerHeightAt, type LayerHeightBounds } from '@printstream/shared/three-mf'
import { isViewportAidMesh } from '../editorGeometry'

/** Marks the meshes this module adds, so the caller can find and dispose them. */
export const LAYER_HEIGHT_OVERLAY_NAME = 'layerHeightOverlay'

/** Texels in the height lookup. Generous: it costs a few hundred bytes and bounds zone-edge jitter. */
export const PROFILE_SAMPLES = 512

/**
 * The cursor GLOWS; it does not tint.
 *
 * BambuStudio mixes the surface toward yellow (`variable_layer_height.fs`), and that is what this
 * did. It cannot work here, because our zones are DISTINCT HUES and two of them are already
 * yellow-adjacent: yellow mixed into the olive zone lands almost exactly on the orange zone, so the
 * cursor reads as a different layer thickness. Reported as "too subtle and even matches other
 * colors at times" -- the ambiguity is the real defect, and blending harder makes it worse.
 *
 * So the cursor is additive light instead. The zone keeps its own hue at full saturation and simply
 * brightens, which no zone can imitate (they differ in hue, never in brightness) and which is what
 * "highlighted" means to the eye anyway. Studio can tint safely because its ramp is one continuous
 * scale; ours cannot, so this is a deliberate divergence.
 */
const BRUSH_GLOW: RGB = [255, 236, 150]
/** Peak additive intensity at the cursor's centre. Falls to nothing at the rim, as Studio's does. */
const BRUSH_PEAK_GLOW = 0.95

type RGB = readonly [number, number, number]

/** Zone colours, thin to thick. Distinct hues rather than a ramp, so adjacent zones cannot blend. */
const ZONE_COLORS: ReadonlyArray<RGB> = [
  [51, 107, 230],
  [51, 184, 219],
  [61, 204, 140],
  [184, 209, 64],
  [242, 168, 51],
  [237, 97, 71],
  [204, 77, 158]
]

/**
 * The zone a layer height falls in, bucketed on Studio's layer-height step measured up from the
 * band's floor. Bucketing on an ABSOLUTE step rather than a fraction of the band keeps a given
 * thickness the same colour whatever printer the project targets, so switching machines does not
 * silently recolour a profile that has not changed.
 */
function zoneColor(height: number, bounds: LayerHeightBounds): RGB {
  const zone = Math.floor((height - bounds.min) / LAYER_HEIGHT_CHANGE_STEP + 1e-6)
  return ZONE_COLORS[Math.min(Math.max(zone, 0), ZONE_COLORS.length - 1)]!
}

/** The same zone colour as CSS, for the thickness BAR. */
export function layerHeightZoneCss(height: number, bounds: LayerHeightBounds): string {
  const [r, g, b] = zoneColor(height, bounds)
  return `rgb(${r}, ${g}, ${b})`
}

export interface LayerHeightBrush {
  /** Brush centre in OBJECT space (height above the model's underside), mm. */
  z: number
  /** Brush extent along Z, mm. Matches what `paintLayerHeightProfile` reaches. */
  bandWidth: number
}

export interface LayerHeightTableOptions {
  profile: ReadonlyArray<number>
  bounds: LayerHeightBounds
  nominalHeight: number
  objectHeight: number
  brush?: LayerHeightBrush | null
}

/**
 * The RGBA lookup the shader samples, one texel per evenly spaced height from the model's base to
 * its top. Pure, and the single source of truth for what any height looks like — the viewport reads
 * it through a texture and the tests read it directly.
 *
 * An empty profile fills with the uniform `nominalHeight`, so an object with no profile yet reads
 * as flat rather than as blank.
 */
export function buildLayerHeightTable(options: LayerHeightTableOptions): Uint8Array {
  const { profile, bounds, nominalHeight, objectHeight, brush } = options
  const table = new Uint8Array(PROFILE_SAMPLES * 4)
  for (let sample = 0; sample < PROFILE_SAMPLES; sample += 1) {
    const z = (sample / (PROFILE_SAMPLES - 1)) * objectHeight
    const height = profile.length >= 2 ? layerHeightAt(profile, z) : nominalHeight
    const [r, g, b] = zoneColor(height, bounds)
    let glow = 0
    if (brush) {
      // Studio's own cursor falloff, kept verbatim: the 1.8 divisor means the visible band reaches a
      // little WIDER than the edit's own half-width, which is deliberate on its part -- the cursor
      // shows where you are pointing, and the edit tapers to nothing near that rim anyway.
      const falloff = Math.abs(Math.PI * (z - brush.z) * 1.8 / Math.max(brush.bandWidth, 1e-6))
      glow = BRUSH_PEAK_GLOW * (0.5 * Math.cos(Math.min(Math.PI, falloff)) + 0.5)
    }
    const offset = sample * 4
    // RGB is the zone, untouched. ALPHA carries the cursor, which the shader adds as emissive light
    // (the material is opaque, so alpha is free to be data rather than coverage).
    table[offset] = r
    table[offset + 1] = g
    table[offset + 2] = b
    table[offset + 3] = Math.round(glow * 255)
  }
  return table
}

/** The shared material + its lookup texture, kept on the object's group so every part reuses one. */
interface LayerHeightShading {
  material: THREE.MeshLambertMaterial
  texture: THREE.DataTexture
  /**
   * The texture's own backing store, held directly rather than reached through
   * `texture.image.data` -- a `DataTexture`'s image is typed to allow a null buffer (it can be
   * backed by a canvas or a video), which this one never is, since we allocate it right here.
   */
  texels: Uint8Array
  uniforms: { uLayerMinZ: THREE.IUniform<number>; uLayerHeight: THREE.IUniform<number> }
}

/**
 * A lit material whose base colour is looked up per fragment from `texture` by world Z.
 *
 * Injected into `MeshLambertMaterial` rather than written as a `ShaderMaterial` so the overlay
 * inherits the scene's real lighting for free and keeps matching the parts around it.
 */
function createShading(): LayerHeightShading {
  const texels = new Uint8Array(PROFILE_SAMPLES * 4)
  const texture = new THREE.DataTexture(texels, PROFILE_SAMPLES, 1)
  // NEAREST is what makes a zone boundary an edge; linear filtering would smooth the very steps
  // that are the point of bucketing at all.
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.needsUpdate = true

  const uniforms = { uLayerMinZ: { value: 0 }, uLayerHeight: { value: 1 } }
  const glow = new THREE.Color(BRUSH_GLOW[0] / 255, BRUSH_GLOW[1] / 255, BRUSH_GLOW[2] / 255)
  const material = new THREE.MeshLambertMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLayerProfile = { value: texture }
    shader.uniforms.uLayerMinZ = uniforms.uLayerMinZ
    shader.uniforms.uLayerHeight = uniforms.uLayerHeight
    shader.uniforms.uLayerGlow = { value: glow }
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vLayerZ;\nvoid main() {')
      // After `begin_vertex`, `transformed` is the vertex in local space; the model matrix takes it
      // to world, which is the frame the profile's heights are measured in.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLayerZ = (modelMatrix * vec4(transformed, 1.0)).z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', [
        'uniform sampler2D uLayerProfile;',
        'uniform float uLayerMinZ;',
        'uniform float uLayerHeight;',
        'uniform vec3 uLayerGlow;',
        'varying float vLayerZ;',
        'vec4 layerTexel;',
        'void main() {'
      ].join('\n'))
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', [
        'float layerT = clamp((vLayerZ - uLayerMinZ) / uLayerHeight, 0.0, 1.0);',
        'layerTexel = texture2D(uLayerProfile, vec2(layerT, 0.5));',
        'vec4 diffuseColor = vec4( layerTexel.rgb, opacity );'
      ].join('\n'))
      // The cursor is ADDED as light rather than mixed into the surface colour, so the zone's hue
      // survives underneath it and cannot be mistaken for a neighbouring zone.
      .replace('vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive + uLayerGlow * layerTexel.a;')
  }
  return { material, texture, texels, uniforms }
}

/**
 * Bring `group`'s layer-height shading in line with `profile` and the brush, building what is
 * missing. Idempotent, so the caller can run it from a plain effect on every relevant commit and
 * after a scene rebuild has dropped the previous meshes.
 */
export function syncLayerHeightVisuals(
  group: THREE.Object3D,
  options: {
    /** The object's printable world-space bounds, from the caller's own `printableMeshBox`. */
    box: THREE.Box3
    profile: ReadonlyArray<number>
    bounds: LayerHeightBounds
    nominalHeight: number
    brush: LayerHeightBrush | null
  }
): void {
  const objectMinWorldZ = options.box.min.z
  const objectHeight = options.box.max.z - objectMinWorldZ
  if (!(objectHeight > 0)) return

  const shading = (group.userData.layerHeightShading as LayerHeightShading | undefined) ?? createShading()
  group.userData.layerHeightShading = shading
  shading.uniforms.uLayerMinZ.value = objectMinWorldZ
  shading.uniforms.uLayerHeight.value = objectHeight
  shading.texels.set(buildLayerHeightTable({ ...options, objectHeight }))
  shading.texture.needsUpdate = true

  const sources: THREE.Mesh[] = []
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || mesh.name === LAYER_HEIGHT_OVERLAY_NAME) return
    // Same "printed geometry only" rule the bounds helpers use: an aid is not part of the model, so
    // tinting one would show layer heights on something that never gets sliced. Ask the shared
    // predicate rather than restating its flags, which is how brim-ear markers (tagged by name, not
    // by a flag) used to end up shaded here.
    if (isViewportAidMesh(mesh)) return
    sources.push(mesh)
  })

  // An overlay is parented to the mesh it shades and carries no transform of its own, so it tracks
  // that mesh through any later move without needing to be rebuilt.
  for (const source of sources) {
    if (source.children.some((child) => child.name === LAYER_HEIGHT_OVERLAY_NAME)) continue
    const overlay = buildLayerHeightOverlay(source, shading.material)
    if (overlay) source.add(overlay)
  }
}

/**
 * A copy of `source`'s surface carrying the shared shading material.
 *
 * Returns null for an indexed geometry: every paint-bearing mesh in the editor is deliberately
 * NON-indexed (triangle N is positions 3N..3N+2), and an indexed one here would mean that invariant
 * moved and this needs revisiting rather than silently drawing something wrong.
 */
function buildLayerHeightOverlay(source: THREE.Mesh, material: THREE.Material): THREE.Mesh | null {
  const geometry = source.geometry as THREE.BufferGeometry
  if (geometry.index) return null
  const position = geometry.getAttribute('position')
  if (!position) return null

  const overlayGeometry = new THREE.BufferGeometry()
  overlayGeometry.setAttribute('position', position.clone())
  // Normals are what make the LIT material work; without them the overlay shades flat and we are
  // back to the glowing silhouette the lit material exists to avoid.
  const normal = geometry.getAttribute('normal')
  if (normal) overlayGeometry.setAttribute('normal', normal.clone())
  else overlayGeometry.computeVertexNormals()

  const overlay = new THREE.Mesh(overlayGeometry, material)
  overlay.name = LAYER_HEIGHT_OVERLAY_NAME
  overlay.renderOrder = 3
  // Flags this as a viewport aid, which is how `printableMeshBox`, `computeFootprintCells`, and
  // `collectWorldTriangles` know to skip it. Missing that, ADAPTIVE reads its own overlay as model
  // geometry and derives the profile from every triangle twice.
  overlay.userData.isLayerHeightVisual = true
  // Not raycastable: the brush is driven from the bar, and a hit here would steal selection clicks.
  overlay.raycast = () => {}
  return overlay
}

/** Remove and dispose every overlay this module added under `group`, and its shared material. */
export function removeLayerHeightVisuals(group: THREE.Object3D): void {
  const doomed: THREE.Object3D[] = []
  group.traverse((node) => {
    if (node.name === LAYER_HEIGHT_OVERLAY_NAME) doomed.push(node)
  })
  for (const node of doomed) {
    node.parent?.remove(node)
    // Geometry is per overlay; the MATERIAL is shared across them all, so it is disposed once below
    // rather than here.
    ;(node as THREE.Mesh).geometry?.dispose()
  }
  const shading = group.userData.layerHeightShading as LayerHeightShading | undefined
  if (!shading) return
  shading.material.dispose()
  shading.texture.dispose()
  delete group.userData.layerHeightShading
}
