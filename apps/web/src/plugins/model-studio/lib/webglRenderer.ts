/**
 * The one place a `WebGLRenderer` is constructed in this plugin, so renderer POLICY is set once.
 *
 * OWNS the debug settings every renderer here should share. Callers still pass their own
 * `WebGLRendererParameters` (antialias, alpha, depth buffer, `preserveDrawingBuffer`) because those
 * genuinely differ per surface: the editor viewport, the read-only preview, the view cube, and the
 * two offscreen thumbnail renderers each want something slightly different.
 *
 * WHY IT EXISTS. `renderer.debug.checkShaderErrors` defaults to true, and three acts on it in
 * `onFirstUse` immediately after `gl.linkProgram`: it calls `getProgramInfoLog` +
 * `getShaderInfoLog`, each of which forces the driver to finish linking SYNCHRONOUSLY rather than
 * letting it compile in parallel. On an 18 MB, 7-plate project open that pair was 5.2% of all
 * non-idle CPU, spent stalling while the scene built its material variants -- and the offscreen
 * thumbnail renderers pay it worst, since a fresh context shares no program cache and recompiles
 * from scratch.
 *
 * WHAT IT DOES NOT BUY, measured rather than assumed. Forcing the flag off and re-running that same
 * open twice removed the calls from the profile entirely (5.2% -> 0%) but left total long-task time
 * UNCHANGED (1737 ms before, 1770 / 1779 ms after) -- the stalls are spread thinly rather than
 * concentrated in the big scene-build tasks, and non-idle is only ~10% of that window to begin with.
 * So this is a real reduction in work and NOT a fix for a visible hitch. Do not cite it as one, and
 * do not go looking for the stutter here.
 *
 * WHY IT STAYS ON IN DEV. We do not just use stock materials: `applyLayerBandOverlays`
 * (`editorGeometry.ts`) and `applyMoireFade` (`gcodePreview.ts`) patch three's shaders by string
 * replacement, injecting GLSL that references three's own internals (`transformed`, `modelMatrix`).
 * A three.js upgrade can make that injected code invalid, and this check is the ONLY thing that
 * would report it -- without it the surface just renders wrong, silently. So developers keep the
 * diagnostic and users get the speed.
 *
 * Adding a sixth renderer? Use this factory. `webglRenderer.test.ts` fails the build on a raw
 * `new THREE.WebGLRenderer` elsewhere in the plugin, because nothing else would catch it.
 */
import * as THREE from 'three'
import { getBrowserEnv } from '../../../lib/browserEnv'

export function createWebglRenderer(parameters?: THREE.WebGLRendererParameters): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer(parameters)
  renderer.debug.checkShaderErrors = getBrowserEnv().devMode
  return renderer
}
