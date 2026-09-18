/** Library model shortcut into the normal new-project flow, preserving its save and cleanup rules. */
import { isMeshLibraryFileKind } from '@printstream/shared'
import { LibraryCreateAction } from './LibraryCreateAction'

/** Only offer model import when the host can create projects and the source is a bare mesh. */
export function LibraryAddToNewProjectAction(props: Record<string, unknown>) {
  if (props.canUpload !== true || typeof props.fileId !== 'string'
    || typeof props.kind !== 'string' || !isMeshLibraryFileKind(props.kind)
    || typeof props.onRequestSlice !== 'function') {
    return null
  }

  return <LibraryCreateAction {...props} presentation="menu-item" initialImportFileId={props.fileId} />
}
