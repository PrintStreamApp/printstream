/**
 * Read-only release history opened from the app version in the shell footer.
 * The catalogue is compiled into the web build so cloud and self-hosted distributions describe
 * exactly the version they are running without relying on an API or external release service.
 */
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import {
  Button,
  Chip,
  DialogActions,
  DialogTitle,
  Divider,
  ModalClose,
  Stack,
  Typography
} from '@mui/joy'
import { BackAwareModal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import {
  formatProductReleaseDate,
  productReleases
} from '../lib/productChangelog'

export function ProductChangelogDialog({
  currentVersion,
  onClose
}: {
  currentVersion: string
  onClose: () => void
}) {
  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 600 }}>
        <ModalClose />
        <DialogTitle>What&apos;s new in PrintStream</DialogTitle>
        <ScrollableDialogBody>
          {productReleases.length === 0 ? (
            <Typography level="body-sm" textColor="text.tertiary">
              Release notes will appear here with the next published version.
            </Typography>
          ) : (
            <Stack spacing={2} divider={<Divider />}>
              {productReleases.map((release) => (
                <Stack key={release.version} spacing={1}>
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Typography level="title-md" sx={{ fontFamily: 'code' }}>
                      v{release.version}
                    </Typography>
                    {release.version === currentVersion && (
                      <Chip size="sm" variant="soft" color="primary">Current</Chip>
                    )}
                    <Typography level="body-xs" textColor="text.tertiary">
                      {formatProductReleaseDate(release.releasedOn)}
                    </Typography>
                  </Stack>
                  <Stack component="ul" spacing={0.75} sx={{ m: 0, pl: 2.5 }}>
                    {release.changes.map((change, index) => (
                      <Typography key={`${release.version}-${index}`} component="li" level="body-sm">
                        {change}
                      </Typography>
                    ))}
                  </Stack>
                </Stack>
              ))}
            </Stack>
          )}
        </ScrollableDialogBody>
        <DialogActions>
          <Button
            autoFocus
            variant="plain"
            color="neutral"
            startDecorator={<CloseRoundedIcon />}
            onClick={onClose}
          >
            Close
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
