/** Stable import-source choices shared by browser and native hosts. */
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded'
import { Button, FormControl, FormLabel, Stack } from '@mui/joy'
import { useState } from 'react'
import { ModelProviderRequiredDialog } from './ModelProviderRequiredDialog'
import { type NativeModelProvider } from '../../native/bridge'

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
  const chooseProvider = (provider: NativeModelProvider, available: boolean) => {
    if (available) onBrowse(provider)
    else setRequiredProvider(provider)
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
        <ModelProviderRequiredDialog provider={requiredProvider} onClose={() => setRequiredProvider(null)} />
      )}
    </>
  )
}
