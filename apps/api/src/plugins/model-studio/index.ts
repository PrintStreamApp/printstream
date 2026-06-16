/**
 * Model studio state plugin.
 *
 * The Three.js editor and preview surfaces live in the web bundle, but the
 * enable / disable state is owned here so the admin plugin registry can
 * persist it and expose it to the client like every other built-in plugin.
 */
import type { ApiPlugin } from '../../plugin/types.js'

export const modelStudioPlugin: ApiPlugin = {
  name: 'model-studio',
  version: '0.1.0',
  description: '3D studio for library files: a multi-plate 3MF project editor with painting, supports, and per-layer filament changes, plus STL, plated 3MF, and G-code previews.',
  async register() {
    // No API routes or background work yet. This plugin exists so web-only
    // editor/preview surfaces participate in the shared install / enable
    // state model.
  }
}