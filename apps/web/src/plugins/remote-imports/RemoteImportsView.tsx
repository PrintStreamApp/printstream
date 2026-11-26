/** Compatibility route for existing remote-import and extension handoff links. */
import { RemoteImportsContent } from './RemoteImportsContent'
import { useRemoteImportsController } from './useRemoteImportsController'

export function RemoteImportsView() {
  return <RemoteImportsContent controller={useRemoteImportsController()} />
}
