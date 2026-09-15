import { useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import NewReleasesRoundedIcon from '@mui/icons-material/NewReleasesRounded'
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded'
import { Button, Chip, Stack, Tooltip } from '@mui/joy'
import { extractErrorMessage, type AppUpdateStartResponse, type AppVersionResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { resolveDisplayedAppBuild } from '../lib/appVersionDisplay'
import { isWebUpdatePending, subscribeWebUpdatePending } from '../lib/appStaleness'
import { waitForNewBuild } from '../lib/appUpdateRestart'
import { hasUnreadProductRelease } from '../lib/productChangelog'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { ConfirmActionDialog } from './ConfirmActionDialog'
import { ProductChangelogDialog } from './ProductChangelogDialog'

const LAST_READ_RELEASE_KEY = 'printstream.productChangelog.lastReadVersion'
const parseStoredVersion = (raw: string): string | null => raw.trim() || null
const serializeStoredVersion = (value: string | null): string => value ?? ''

/**
 * Footer line showing the loaded UI's version and, for the published
 * open-core image, a subtle "update available" hint when GHCR's `:latest` is a
 * newer build. The visible version comes from this browser bundle, not the API:
 * after a deploy, the API can be newer while this tab is waiting for a safe
 * automatic reload. Update availability and permissions remain server-owned.
 * The version is also the entry point to the bundled product changelog. A
 * per-device last-read version gives a newly published entry a one-time visual
 * treatment without adding server-side notification state.
 *
 * On the native app the hint is also the TRIGGER: `canApplyUpdate` (settings
 * managers only) makes the chip clickable, and confirming posts
 * `/api/app/update/start`: the server backs up its database, verifies the
 * signed build, swaps its executable, and restarts (`native-update-apply.ts`).
 * The page then polls `/api/app/version` until a different build answers and
 * reloads itself.
 *
 * `updatesLapsed` is the same hint with a renewal prompt: a newer build exists
 * but the install's updates & support period has ended. It is deliberately
 * still a chip and not a warning: the build they own keeps running.
 */
export function AppVersionFooter() {
  const { data } = useQuery({
    queryKey: ['app', 'version'],
    queryFn: ({ signal }) => apiFetch<AppVersionResponse>('/api/app/version', { signal }),
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false
  })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const safeReloadPending = useSyncExternalStore(
    subscribeWebUpdatePending,
    isWebUpdatePending,
    () => false
  )
  // Once true, the server is swapping its binary; the dialog stays up (and
  // uncloseable) until the new build answers and the page reloads itself.
  const [restarting, setRestarting] = useState(false)
  const [restartTimedOut, setRestartTimedOut] = useState(false)

  const startUpdate = useMutation({
    mutationFn: () => apiFetch<AppUpdateStartResponse>('/api/app/update/start', { method: 'POST' }),
    onSuccess: async () => {
      setRestarting(true)
      const cameBack = await waitForNewBuild({
        previousRevision: data?.revision ?? null,
        fetchVersion: () => apiFetch<AppVersionResponse>('/api/app/version').catch(() => null)
      })
      if (cameBack) {
        window.location.reload()
        return
      }
      setRestarting(false)
      setRestartTimedOut(true)
    }
  })

  const displayedBuild = resolveDisplayedAppBuild(data)
  const [lastReadRelease, setLastReadRelease] = useLocalStorageState<string | null>(
    LAST_READ_RELEASE_KEY,
    null,
    parseStoredVersion,
    serializeStoredVersion
  )
  const releaseUnread = hasUnreadProductRelease(displayedBuild.version, lastReadRelease)
  const update = data?.update
  const lapsed = update?.status === 'updatesLapsed'
  const hasUpdate = update?.status === 'updateAvailable' || lapsed
  const canApply = Boolean(data?.canApplyUpdate && !lapsed)
  const uiReloadRequired = displayedBuild.reloadRequired || safeReloadPending
  const targetBuild = update?.latestShortRevision ? ` build ${update.latestShortRevision}` : ' the new build'

  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      useFlexGap
      sx={{ flexWrap: 'wrap', justifyContent: 'center' }}
    >
      {uiReloadRequired ? (
        <Tooltip
          variant="soft"
          title={describePendingUiReload(displayedBuild.version, displayedBuild.serverVersion)}
        >
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            onClick={() => {
              setLastReadRelease(displayedBuild.version)
              setChangelogOpen(true)
            }}
            sx={{ fontFamily: 'code' }}
          >
            v{displayedBuild.version} (UI reload required)
          </Chip>
        </Tooltip>
      ) : (
        <Tooltip title={releaseUnread ? 'See what changed in this version' : 'View release notes'} variant="soft">
          <Button
            size="sm"
            variant={releaseUnread ? 'soft' : 'plain'}
            color={releaseUnread ? 'primary' : 'neutral'}
            startDecorator={releaseUnread ? <NewReleasesRoundedIcon fontSize="small" /> : undefined}
            aria-label={`View release notes for PrintStream v${displayedBuild.version}`}
            title={displayedBuild.revision ?? undefined}
            onClick={() => {
              setLastReadRelease(displayedBuild.version)
              setChangelogOpen(true)
            }}
            sx={{ minHeight: 24, fontFamily: 'code', fontSize: 'xs' }}
          >
            v{displayedBuild.version}
          </Button>
        </Tooltip>
      )}
      {hasUpdate && update && (
        <Tooltip variant="soft" title={describeUpdate(update, canApply)}>
          <Chip
            size="sm"
            variant="soft"
            color={lapsed ? 'neutral' : 'warning'}
            onClick={canApply ? () => setConfirmOpen(true) : undefined}
          >
            {lapsed ? 'Updates lapsed' : 'Update available'}
          </Chip>
        </Tooltip>
      )}
      <ConfirmActionDialog
        open={confirmOpen}
        title="Update PrintStream?"
        description={restarting
          ? 'PrintStream is restarting into the new build. This page reloads automatically when it is back.'
          : `PrintStream will download and verify${targetBuild}, then restart into it, its database is backed up before anything migrates. ` +
            'The app will be unavailable for a minute; anything printing continues on the printer.'}
        confirmLabel="Update now"
        color="primary"
        confirmDecorator={<SystemUpdateAltRoundedIcon />}
        pending={startUpdate.isPending || restarting}
        error={restartTimedOut
          ? 'The app has not come back yet. Give it another minute and reload this page; if it stays down, check the PrintStream service on the server.'
          : startUpdate.error ? extractErrorMessage(startUpdate.error, 'The update could not be started.') : null}
        onClose={() => {
          if (startUpdate.isPending || restarting) return
          setConfirmOpen(false)
          setRestartTimedOut(false)
          startUpdate.reset()
        }}
        onConfirm={() => {
          if (startUpdate.isPending || restarting) return
          setRestartTimedOut(false)
          startUpdate.mutate()
        }}
      />
      {changelogOpen && (
        <ProductChangelogDialog
          currentVersion={displayedBuild.version}
          onClose={() => setChangelogOpen(false)}
        />
      )}
    </Stack>
  )
}

function describePendingUiReload(uiVersion: string, serverVersion: string | null): string {
  const versionDifference = serverVersion && serverVersion !== uiVersion
    ? ` This tab is running v${uiVersion}, while the server is v${serverVersion}.`
    : ''
  return `A newer PrintStream UI is ready.${versionDifference} Save or finish your current work; the UI will reload automatically as soon as it is safe.`
}

function describeUpdate(update: NonNullable<AppVersionResponse['update']>, canApply: boolean): string {
  const target = update.latestShortRevision ? ` (build ${update.latestShortRevision})` : ''
  if (update.status === 'updatesLapsed') {
    return `A newer build is available${target}, but updates and priority support for this license have ended. Renew to install it: the build you have keeps running.`
  }
  if (canApply) {
    return `A newer version is available${target}. Click to update: the app backs up its database and restarts itself.`
  }
  // Two channels want different sentences: the Docker operator runs a command,
  // the native viewer is pointed at whoever can click the button. Saying
  // "image" to someone running the single-file app describes something they do
  // not have.
  if (update.downloadUrl) {
    return `A newer version is available${target}. A settings manager can install it in one click from this footer.`
  }
  const pull = update.imageRef ? ` Pull ${update.imageRef} to update.` : ''
  return `A newer ${update.imageRef ? 'image' : 'version'} is available${target}.${pull}`
}
