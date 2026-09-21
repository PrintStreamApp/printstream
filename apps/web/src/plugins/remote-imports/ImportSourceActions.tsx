/** Stable import-source choices shared by browser and native hosts. */
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded'
import { Button, FormControl, FormLabel, Stack, Typography } from '@mui/joy'
import { useState } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { NativeAppDownloadsDialog } from '../../components/NativeAppDownloadsDialog'
import { isNativeApp, type NativeModelProvider } from '../../native/bridge'
import { useRuntimePolicy } from '../../lib/runtimePolicy'
import { detectNativeModelBrowserApp } from './nativeModelBrowserApp'

const PROVIDER_LABELS: Record<NativeModelProvider, string> = {
  makerworld: 'MakerWorld',
  printables: 'Printables'
}

export function ImportSourceActions({
  canBrowseMakerWorld,
  canBrowsePrintables,
  pendingProvider,
  disabled,
  fromUrlSelected,
  onBrowse,
  onFromUrl
}: {
  canBrowseMakerWorld: boolean
  canBrowsePrintables: boolean
  pendingProvider: NativeModelProvider | null
  disabled: boolean
  fromUrlSelected: boolean
  onBrowse: (provider: NativeModelProvider) => void
  onFromUrl: () => void
}) {
  const [requiredProvider, setRequiredProvider] = useState<NativeModelProvider | null>(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const nativeApp = isNativeApp()
  const recommendation = detectNativeModelBrowserApp()
  const { selfHosted } = useRuntimePolicy()

  const chooseProvider = (provider: NativeModelProvider, available: boolean) => {
    if (available) onBrowse(provider)
    else setRequiredProvider(provider)
  }
  const closeDialog = () => setRequiredProvider(null)
  const openStore = () => {
    if (!nativeApp) {
      closeDialog()
      setDownloadsOpen(true)
      return
    }
    if (recommendation.storeUrl) {
      window.open(recommendation.storeUrl, '_blank', 'noopener,noreferrer')
    }
    closeDialog()
  }

  return (
    <>
      <FormControl>
        <FormLabel>Import source</FormLabel>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="soft"
            startDecorator={<LaunchRoundedIcon />}
            loading={pendingProvider === 'makerworld'}
            disabled={disabled}
            onClick={() => chooseProvider('makerworld', canBrowseMakerWorld)}
          >
            MakerWorld
          </Button>
          <Button
            variant="soft"
            color="neutral"
            startDecorator={<LaunchRoundedIcon />}
            loading={pendingProvider === 'printables'}
            disabled={disabled}
            onClick={() => chooseProvider('printables', canBrowsePrintables)}
          >
            Printables
          </Button>
          <Button
            variant={fromUrlSelected ? 'soft' : 'outlined'}
            color={fromUrlSelected ? 'primary' : 'neutral'}
            startDecorator={<LinkRoundedIcon />}
            disabled={disabled}
            onClick={onFromUrl}
          >
            From URL
          </Button>
        </Stack>
      </FormControl>

      {requiredProvider && (
        <FormDialog
          title={`Import from ${PROVIDER_LABELS[requiredProvider]} with a PrintStream app`}
          description={null}
          submitLabel={nativeApp ? recommendation.storeLabel : 'Download the app'}
          cancelLabel="Close"
          onClose={closeDialog}
          onSubmit={openStore}
          width="min(480px, 100%)"
        >
          <Typography level="body-sm">
            {nativeApp
              ? `Update the PrintStream app for ${recommendation.platformLabel} to browse ${PROVIDER_LABELS[requiredProvider]}, sign in or complete a security check, and import the download directly.`
              : `PrintStream has desktop and mobile apps that can browse ${PROVIDER_LABELS[requiredProvider]}, handle sign-in or security checks, and import the download directly.`}
          </Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            {nativeApp
              ? 'You can also close this message and try From URL.'
              : 'You can also close this message and try From URL in this browser. Provider security checks may still block the download.'}
          </Typography>
        </FormDialog>
      )}
      {!nativeApp ? (
        <NativeAppDownloadsDialog
          open={downloadsOpen}
          onClose={() => setDownloadsOpen(false)}
          useHostedCatalogue={selfHosted}
        />
      ) : null}
    </>
  )
}
