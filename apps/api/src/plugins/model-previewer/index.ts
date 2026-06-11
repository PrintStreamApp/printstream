/**
 * Model previewer state plugin.
 *
 * The Three.js preview surface lives in the web bundle, but the enable /
 * disable state is owned here so the admin plugin registry can persist it and
 * expose it to the client like every other built-in plugin.
 */
import type { ApiPlugin } from '../../plugin/types.js'

export const modelPreviewerPlugin: ApiPlugin = {
  name: 'model-previewer',
  version: '0.1.0',
  description: 'Three.js viewer for STL files. Adds a Preview action to library rows.',
  async register() {
    // No API routes or background work yet. This plugin exists so web-only
    // preview surfaces participate in the shared install / enable state model.
  }
}