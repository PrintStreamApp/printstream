/** Shared app-required explanation for menu and legacy import-page entry points. */
import { useState } from 'react'
import { Typography } from '@mui/joy'
import { FormDialog } from '../../components/FormDialog'
import { NativeAppDownloadsDialog } from '../../components/NativeAppDownloadsDialog'
import { isNativeApp, type NativeModelProvider } from '../../native/bridge'
import { useRuntimePolicy } from '../../lib/runtimePolicy'
import { detectNativeModelBrowserApp } from './nativeModelBrowserApp'

export function ModelProviderRequiredDialog({ provider, onClose }: {
  provider: NativeModelProvider
  onClose: () => void
}) {
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const nativeApp = isNativeApp()
  const recommendation = detectNativeModelBrowserApp()
  const { selfHosted } = useRuntimePolicy()
  const label = provider === 'makerworld' ? 'MakerWorld' : 'Printables'

  return downloadsOpen ? (
    <NativeAppDownloadsDialog open onClose={onClose} useHostedCatalogue={selfHosted} />
  ) : (
    <FormDialog
      title={`Import from ${label} with a PrintStream app`}
      description={null}
      submitLabel={nativeApp ? recommendation.storeLabel : 'Download the app'}
      cancelLabel="Close"
      onClose={onClose}
      onSubmit={() => {
        if (!nativeApp) {
          setDownloadsOpen(true)
        } else {
          if (recommendation.storeUrl) window.open(recommendation.storeUrl, '_blank', 'noopener,noreferrer')
          onClose()
        }
      }}
      width="min(480px, 100%)"
    >
      <Typography level="body-sm">
        {nativeApp
          ? `Update the PrintStream app for ${recommendation.platformLabel} to browse ${label}, sign in or complete a security check, and choose where each model is saved.`
          : `PrintStream has desktop and mobile apps that can browse ${label}, handle sign-in or security checks, and import the download directly.`}
      </Typography>
      <Typography level="body-sm" textColor="text.tertiary">
        You can also close this message and choose From URL in the Upload menu. Provider security checks may still block the download.
      </Typography>
    </FormDialog>
  )
}
