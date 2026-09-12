/**
 * Deployment seam for classifying workspace slices without importing cloud billing into core.
 *
 * Self-hosted builds have no plan concept and receive the highest workspace tier. The private cloud
 * module registers its subscription-backed resolver during startup.
 */
import type { SlicingExecutionTier } from './slicing-execution-scheduler.js'

type WorkspaceSlicingTierResolver = (workspaceId: string) => Promise<Exclude<SlicingExecutionTier, 'anonymous'>>

let resolver: WorkspaceSlicingTierResolver = async () => 'paid'

export function registerWorkspaceSlicingTierResolver(next: WorkspaceSlicingTierResolver): void {
  resolver = next
}

export async function resolveWorkspaceSlicingTier(workspaceId: string): Promise<Exclude<SlicingExecutionTier, 'anonymous'>> {
  return await resolver(workspaceId)
}
