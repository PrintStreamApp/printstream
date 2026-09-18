/**
 * Server backup contracts (issue #78): the install's built-in whole-install
 * backups, one `pg_dump` of the database plus a snapshot of the persistent
 * data tree per backup, and the staged restore flow. Self-hosted installs
 * manage them from Settings; cloud deployments from the platform workspace.
 *
 * Counterparts: `apps/api/src/lib/server-backup-*.ts` (engine/schedule/restore),
 * `apps/api/src/routes/server-backups.ts`, and the web settings section. The
 * bridge's own on-disk backups (#61) are a separate surface with their own
 * contracts in `bridges.ts`.
 */
import { z } from 'zod'

export const serverBackupTriggerSchema = z.enum(['scheduled', 'manual', 'pre-restore'])

export type ServerBackupTrigger = z.infer<typeof serverBackupTriggerSchema>

/**
 * One completed backup on the install's disk. `restoreBlockedReason` is the
 * server's verdict on whether THIS install can restore it (a backup from a
 * newer app version or a newer Postgres major is refused), so the UI never
 * offers a restore the boot-time apply would reject.
 */
export const serverBackupSnapshotSchema = z.object({
  /** Snapshot directory name inside the backups dir (`server-backup-<timestamp>`). */
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  trigger: serverBackupTriggerSchema,
  /** Build revision of the app that took the backup, for display; null on source runs. */
  appRevision: z.string().nullable(),
  /** Postgres server version the dump came from (e.g. "16.4"). */
  postgresVersion: z.string().nullable(),
  dbDumpBytes: z.number().int().nonnegative(),
  dataFileCount: z.number().int().nonnegative(),
  /** Logical size of the data-tree snapshot (hardlinked files count in full). */
  dataTotalBytes: z.number().int().nonnegative(),
  /** Bytes physically written by this run (the rest was hardlinked, unchanged). */
  copiedBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  restoreBlockedReason: z.string().nullable()
})

export type ServerBackupSnapshot = z.infer<typeof serverBackupSnapshotSchema>

export const serverBackupStatusSchema = z.object({
  /**
   * Backups can run on this install: a backups directory is resolved and the
   * Postgres client tools are present. When false, `unavailableReason` says
   * why (e.g. the native build does not ship pg_dump yet).
   */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  directory: z.string().nullable(),
  /** Scheduled cadence in hours; 0 = manual backups only. */
  intervalHours: z.number().nonnegative(),
  /** Absolute retention cap for every trigger; absent/null preserves the self-hosted retention ladder. */
  maxAgeDays: z.number().positive().nullable().optional(),
  running: z.boolean(),
  snapshotCount: z.number().int().nonnegative(),
  /** Logical bytes across all snapshots (on-disk usage is lower via hardlinks). */
  totalBytes: z.number().int().nonnegative(),
  /** Free space on the backup disk, when the platform can report it. */
  freeBytes: z.number().int().nonnegative().nullable(),
  lastBackupAt: z.string().datetime().nullable(),
  nextDueAt: z.string().datetime().nullable(),
  /** Why the most recent backup attempt failed, or null when it succeeded. */
  lastError: z.string().nullable(),
  /** A staged restore is waiting for the app to restart and apply it. */
  restorePending: z.boolean()
})

export type ServerBackupStatus = z.infer<typeof serverBackupStatusSchema>

export const serverBackupListResponseSchema = z.object({
  status: serverBackupStatusSchema,
  snapshots: z.array(serverBackupSnapshotSchema)
})

export type ServerBackupListResponse = z.infer<typeof serverBackupListResponseSchema>

export const serverBackupRunResponseSchema = z.object({
  status: serverBackupStatusSchema
})

export type ServerBackupRunResponse = z.infer<typeof serverBackupRunResponseSchema>

/**
 * Accepted means the app took a pre-restore safety backup, staged the restore
 * marker, and is about to exit; the service manager or container restart
 * policy brings it back up, and the restore is applied on boot before the app
 * opens the database. The caller should expect the connection to drop.
 */
export const serverBackupRestoreResponseSchema = z.object({
  accepted: z.literal(true),
  message: z.string().min(1)
})

export type ServerBackupRestoreResponse = z.infer<typeof serverBackupRestoreResponseSchema>
