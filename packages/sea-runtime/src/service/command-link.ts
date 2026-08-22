/**
 * PATH entry for a standalone Unix install: a symlink in `/usr/local/bin` to
 * the installed executable, so the command every surface prints is true as
 * printed.
 *
 * Owns nothing else: the install dir is `/opt/<app>/`, which is on no shell's
 * PATH, and the service install never linked it anywhere. So `printstream-bridge
 * status`, printed by the installer, the running service, the web download
 * card, and the docs, resolved only for someone who already knew the install
 * layout, which is exactly the person who does not need to be told the command.
 *
 * Contract: both calls are best-effort and never throw, because a PATH entry is
 * convenience and must not fail an install or an uninstall. Both refuse to
 * touch anything they did not create: a non-symlink at the target is left
 * alone (it is somebody else's binary), and removal unlinks only a symlink that
 * still points into our install dir.
 */
import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'

/** Where a Unix install puts commands that should be on PATH for every user. */
const COMMAND_LINK_DIR = '/usr/local/bin'

export interface CommandLinkInput {
  /** Absolute path of the installed executable the link should point at. */
  exePath: string
  /** Command name to expose, e.g. `printstream-bridge`. */
  commandName: string
  /** Overrides `/usr/local/bin`, for tests and non-standard prefixes. */
  linkDir?: string
}

/**
 * Creates (or re-points) `/usr/local/bin/<commandName>`. Returns the link path
 * when the command is now on PATH, or null when nothing was linked: not Linux,
 * not permitted (an unprivileged install), or the name is already taken by a
 * real file.
 *
 * Re-pointing an existing SYMLINK is deliberate: a reinstall that moves the
 * executable would otherwise leave a link to a binary that is about to be
 * deleted, which fails in a way ("No such file or directory") that reads as a
 * broken install rather than a stale link.
 */
export async function ensureCommandLink(input: CommandLinkInput): Promise<string | null> {
  if (process.platform !== 'linux') return null

  const linkDir = input.linkDir ?? COMMAND_LINK_DIR
  const linkPath = path.join(linkDir, input.commandName)
  try {
    const existing = await lstat(linkPath).catch(() => null)
    if (existing && !existing.isSymbolicLink()) return null
    await mkdir(linkDir, { recursive: true })
    if (existing) await unlink(linkPath)
    await symlink(input.exePath, linkPath)
    return linkPath
  } catch {
    // Permission (an unprivileged install) or a read-only prefix. A missing
    // PATH entry is a smaller problem than a failed install.
    return null
  }
}

/**
 * Removes the PATH symlink, but only when it is still ours: a symlink pointing
 * at the executable we installed (or anywhere inside its install dir, so a link
 * left by an earlier layout is still cleaned up). Anything else is left where
 * it is.
 */
export async function removeCommandLink(input: CommandLinkInput): Promise<void> {
  if (process.platform !== 'linux') return

  const linkDir = input.linkDir ?? COMMAND_LINK_DIR
  const linkPath = path.join(linkDir, input.commandName)
  try {
    const existing = await lstat(linkPath).catch(() => null)
    if (!existing?.isSymbolicLink()) return
    const target = await readlink(linkPath)
    if (!isOurTarget(linkDir, target, input.exePath)) return
    await unlink(linkPath)
  } catch {
    // Best-effort: a leftover link is a smaller problem than a failed uninstall.
  }
}

function isOurTarget(linkDir: string, target: string, exePath: string): boolean {
  const resolvedTarget = path.resolve(linkDir, target)
  const resolvedExe = path.resolve(exePath)
  if (resolvedTarget === resolvedExe) return true
  const installDir = `${path.dirname(resolvedExe)}${path.sep}`
  return resolvedTarget.startsWith(installDir)
}
