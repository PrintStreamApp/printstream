import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { Alert, Box, Button, DialogTitle, Stack, Typography } from '@mui/joy'
import {
  LAN_ONLY_MODE_TRADEOFF,
  MANAGED_BRIDGE_STEP,
  PRINTER_CONNECTIVITY_INTRO,
  PRINTER_CONNECTIVITY_STEPS
} from '../lib/printerConnectivityGuide'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { BackAwareModal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

/**
 * "How printers connect" explainer dialog: local bridge, LAN Only Mode +
 * access code, and Developer Mode on newer Bambu firmware. Copy comes from
 * `lib/printerConnectivityGuide.ts` (shared with the marketing site). In
 * managed-bridge installs the bridge step is replaced with built-in-service
 * wording, matching the rest of the app's managed-bridge voice.
 */
export function ConnectivityGuideDialog({ onClose }: { onClose: () => void }) {
  const { managedBridge } = useRuntimePolicy()
  const steps = managedBridge
    ? [MANAGED_BRIDGE_STEP, ...PRINTER_CONNECTIVITY_STEPS.filter((step) => step.id !== 'bridge')]
    : PRINTER_CONNECTIVITY_STEPS

  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 520 } }}>
        <DialogTitle>How printers connect</DialogTitle>
        <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
          <Stack spacing={1.5}>
            <Typography level="body-sm" textColor="text.tertiary">
              {PRINTER_CONNECTIVITY_INTRO}
            </Typography>
            <Stack spacing={1.25}>
              {steps.map((step, index) => (
                <Stack key={step.id} direction="row" spacing={1.25} alignItems="flex-start">
                  <Box
                    aria-hidden="true"
                    sx={{
                      width: 28,
                      height: 28,
                      flexShrink: 0,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      backgroundColor: 'background.level2',
                      color: 'primary.softColor',
                      fontWeight: 'lg',
                      fontSize: 'sm'
                    }}
                  >
                    {index + 1}
                  </Box>
                  <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                    <Typography level="title-sm">{step.title}</Typography>
                    <Typography level="body-sm" textColor="text.tertiary">{step.body}</Typography>
                  </Stack>
                </Stack>
              ))}
            </Stack>
            <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
              <Typography level="body-sm">{LAN_ONLY_MODE_TRADEOFF}</Typography>
            </Alert>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.5 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
