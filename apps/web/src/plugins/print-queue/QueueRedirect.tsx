/**
 * Legacy-route shim: the queue used to be its own top-level "/queue" view before it
 * moved onto the Jobs page (the `jobs.sections` slot). Old bookmarks, installed-PWA
 * shortcuts, and a saved "landing page" preference of /queue still resolve here, so
 * keep this unlisted route redirecting to /jobs instead of letting those 404 to home.
 */
import { Navigate, useParams } from 'react-router-dom'
import { buildWorkspacePath } from '../../lib/workspaceRoute'

export function QueueRedirect() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  return <Navigate to={workspaceSlug ? buildWorkspacePath(workspaceSlug, '/jobs') : '/jobs'} replace />
}
