/**
 * Loads the process catalog only when an editor settings dialog opens.
 * Its local boundary keeps a slow or failed chunk from unmounting the editor.
 */
import { lazy, type ComponentProps } from 'react'
import { LazyDialogBoundary } from '../../components/LazyDialogBoundary'

const ProcessSettingsDialogImpl = lazy(() => import('../../components/ProcessSettingsDialog'))

/** Preserve the editor while the heavy settings dialog loads. */
export function LazyProcessSettingsDialog(props: ComponentProps<typeof ProcessSettingsDialogImpl>) {
  return (
    <LazyDialogBoundary label="settings" onClose={props.onClose}>
      <ProcessSettingsDialogImpl {...props} />
    </LazyDialogBoundary>
  )
}
