/**
 * Retention sweep for deleted workspaces.
 *
 * A workspace an owner deletes is only marked (`deletedAt`) so it can be
 * restored; this is the pass that eventually makes it real. It is the ONLY
 * irreversible half of the feature, which is why it lives on its own rather than
 * inside the delete endpoint: nothing a user clicks should be able to reach it.
 *
 * Runs from the daily artifact maintenance pass because that is what it is: the
 * hard delete cascades the workspace's rows, and its stored BYTES have to go
 * with them or they orphan forever with nothing left pointing at them.
 *
 * One workspace at a time, and a failure on one does not stop the rest: these
 * are independent, and a single wedged workspace (an offline bridge, a locked
 * file) must not park the whole sweep and let every other deleted workspace
 * accumulate behind it.
 */
import { env } from './env.js'
import { rootPrisma } from './prisma.js'
import { deleteWorkspaceArtifactBytes } from './workspace-artifacts.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface WorkspaceSweepResult {
  removed: number
  failed: number
}

/**
 * Hard-delete workspaces whose restore window has passed.
 *
 * Exported for tests and callable on its own; the daily maintenance pass is the
 * only production caller.
 */
export async function pruneDeletedWorkspaces(now: Date = new Date()): Promise<WorkspaceSweepResult> {
  const cutoff = new Date(now.getTime() - env.WORKSPACE_DELETED_RETENTION_DAYS * ONE_DAY_MS)
  // Deliberately NOT through `visibleWorkspacesWhere`: this is one of the three
  // places that must see deleted rows, since they are its entire subject.
  const due = await rootPrisma.workspace.findMany({
    where: { deletedAt: { not: null, lte: cutoff } },
    select: { id: true, name: true }
  })

  let removed = 0
  let failed = 0
  for (const workspace of due) {
    try {
      // Bytes BEFORE the cascade, or the rows that point at them are gone and
      // the files are unreachable, the same ordering the platform delete uses.
      await deleteWorkspaceArtifactBytes(workspace.id)
      await rootPrisma.workspace.delete({ where: { id: workspace.id } })
      removed += 1
    } catch (error) {
      failed += 1
      // Named, not swallowed: a workspace that cannot be removed will be retried
      // every day forever, and silence would make that invisible.
      console.error('[workspace-cleanup] could not remove a deleted workspace', {
        workspaceId: workspace.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (removed > 0) {
    console.log(`[workspace-cleanup] removed ${removed} workspace${removed === 1 ? '' : 's'} past the ${env.WORKSPACE_DELETED_RETENTION_DAYS}-day restore window`)
  }
  return { removed, failed }
}
