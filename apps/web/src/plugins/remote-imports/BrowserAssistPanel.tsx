import Alert from '@mui/joy/Alert'
import Stack from '@mui/joy/Stack'
import Typography from '@mui/joy/Typography'
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { getBrowserAssistStatusCopy } from './browserAssistState'

type BrowserAssistPanelProps = {
  extensionDetected: boolean | null
  providerLabel: string
}

/**
 * The notice for a page PrintStream cannot fetch itself, in practice a Printables
 * model page, since MakerWorld now resolves server-side through the connected Bambu
 * Lab account.
 *
 * Two audiences, and the difference matters: someone running the companion browser
 * helper gets the handoff instructions, while someone without it is told plainly that
 * this site is not importable yet and what to do instead. The helper is not pitched or
 * linked to anyone: see `browserAssistState.ts` for why.
 *
 * It stands in for `RemoteImportsView`'s generic resolution alert for these URLs (that
 * alert is suppressed there). The link that opens the provider page lives on the Source
 * URL field in `RemoteImportsView`, not here.
 */
export function BrowserAssistPanel({ extensionDetected, providerLabel }: BrowserAssistPanelProps) {
  const statusCopy = getBrowserAssistStatusCopy(extensionDetected)
  const detected = extensionDetected === true

  return (
    <Alert
      variant="soft"
      // Neutral, not warning: nothing has gone wrong, this site simply publishes no
      // link PrintStream can fetch.
      color={detected ? 'success' : 'neutral'}
      startDecorator={detected ? <ExtensionRoundedIcon /> : <InfoOutlinedIcon />}
      sx={{ alignItems: 'flex-start' }}
    >
      <Stack spacing={0.5}>
        <Typography level="title-sm">
          {detected ? `${providerLabel} model page` : `${providerLabel} pages cannot be imported yet`}
        </Typography>
        <Typography level="body-sm">
          {providerLabel} does not publish a file link PrintStream can download on its own.
        </Typography>
        {statusCopy && <Typography level="body-sm">{statusCopy.message}</Typography>}
      </Stack>
    </Alert>
  )
}
