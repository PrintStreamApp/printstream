/**
 * Model studio plugin.
 *
 * Owns the multi-plate 3MF project editor and the Three.js viewers for STL
 * files, plate-scoped 3MF previews, and sliced G-code toolpaths.
 *
 * The plugin extends four surfaces:
 * - A `library.fileActions` slot that core library rows render inside the
 *   kebab menu to add a preview action with an icon.
 * - A `library.overlays` slot that lets host surfaces (the library page, the
 *   slice dialog, and the slice results dialog) show the preview dialog without
 *   changing the current URL.
 * - A `slicing.editor` slot that adds an "Edit in 3D" button to the slicing
 *   dialog, opening the interactive multi-plate layout editor. The editor hands
 *   a `SceneEdit` back to the host via the slot's `onApply` context callback.
 * - A `library.create` slot that adds a "New 3D project" button to the library
 *   toolbar, opening the editor with no base file so the user can import/arrange
 *   models and save them as a brand-new library 3MF.
 *
 * It also registers a client-side STL thumbnail renderer so core library rows
 * can show model previews for STL files (which have no server-side thumbnail).
 * The heavy renderer module is imported lazily on first use.
 */
import type { WebPlugin } from '../../plugin/types'
import { registerMeshThumbnailProvider, registerSceneThumbnailProvider } from '../../lib/modelThumbnailRegistry'
import { LibraryCreateAction } from './LibraryCreateAction'
import { LibraryPreviewAction } from './LibraryPreviewAction'
import { PreviewOverlay } from './PreviewOverlay'
import { SlicingEditorAction } from './SlicingEditorAction'

export const modelStudioPlugin: WebPlugin = {
  name: 'model-studio',
  version: '0.1.0',
  description: '3D studio for library files: a multi-plate 3MF project editor with painting, supports, and per-layer filament changes, plus STL, STEP, plated 3MF, and G-code previews.',
  slots: [
    { name: 'library.fileActions', component: LibraryPreviewAction },
    { name: 'library.overlays', component: PreviewOverlay },
    { name: 'slicing.editor', component: SlicingEditorAction },
    { name: 'library.create', component: LibraryCreateAction }
  ],
  init: () => {
    registerMeshThumbnailProvider(async (file, signal) => {
      const { renderMeshThumbnail } = await import('./lib/meshThumbnail')
      return renderMeshThumbnail(file, signal)
    })
    registerSceneThumbnailProvider(async (fileId, plate, signal) => {
      const { renderLibraryFileThumbnail } = await import('./lib/libraryFileThumbnail')
      return renderLibraryFileThumbnail(fileId, plate, signal)
    })
  }
}
