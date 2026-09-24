/** One-time browser promotion for the matching released native client after sign-in. */
import AndroidRoundedIcon from '@mui/icons-material/AndroidRounded'
import DesktopWindowsRoundedIcon from '@mui/icons-material/DesktopWindowsRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { Button, DialogActions, DialogContent, DialogTitle, ModalClose, ModalDialog, Typography } from '@mui/joy'
import { useEffect, useRef, useState } from 'react'
import React from 'react'
import { isAppBusy, subscribeAppBusy } from '../lib/appBusy'
import {
  clearNativeAppPromotionAfterSignInFlag,
  detectNativeAppPromotion,
  dismissNativeAppPromotion,
  hasNativeAppPromotionAfterSignInFlag,
  isNativeAppPromotionDismissed,
  resetNativeAppPromotionDismissalForDevelopment,
  type NativeAppPromotion
} from '../lib/nativeAppPromotion'
import { isNativeApp } from '../native/bridge'
import { BackAwareModal } from './BackAwareModal'

export function NativeAppPromotionDialog({
  authenticated,
  onBrowseDownloads
}: {
  authenticated: boolean
  onBrowseDownloads: () => void
}) {
  const evaluated = useRef(false)
  const [candidate, setCandidate] = useState<NativeAppPromotion | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!authenticated || evaluated.current) return
    evaluated.current = true

    if (isNativeApp()) {
      clearNativeAppPromotionAfterSignInFlag()
      return
    }

    // Development hot reloads used to consume the session signal before the offer could appear.
    // Recover an undismissed offer in dev so refreshing remains a reliable way to test it.
    const isDevelopment = import.meta.env?.DEV === true
    if (!hasNativeAppPromotionAfterSignInFlag() && !isDevelopment) return

    const promotion = detectNativeAppPromotion()
    if (!promotion) return
    if (isDevelopment) resetNativeAppPromotionDismissalForDevelopment(promotion.platform)
    if (isNativeAppPromotionDismissed(promotion.platform)) {
      clearNativeAppPromotionAfterSignInFlag()
      return
    }
    setCandidate(promotion)
  }, [authenticated])

  // Other post-sign-in offers may mount in the same shell pass. Wait until their dialog closes
  // instead of stacking two modals and making the later one impossible to understand.
  useEffect(() => {
    if (!candidate || open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const showWhenIdle = () => {
      if (cancelled || isAppBusy()) return
      timer = setTimeout(() => {
        if (!cancelled && !isAppBusy()) setOpen(true)
      }, 0)
    }

    const unsubscribe = subscribeAppBusy(showWhenIdle)
    showWhenIdle()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [candidate, open])

  if (!candidate) return null

  const dismiss = () => {
    clearNativeAppPromotionAfterSignInFlag()
    dismissNativeAppPromotion(candidate.platform)
    setOpen(false)
    setCandidate(null)
  }

  return (
    <BackAwareModal open={open} onClose={dismiss}>
      <ModalDialog variant="outlined" sx={{ width: 'min(440px, 100%)' }}>
        <ModalClose />
        <DialogTitle sx={{ alignItems: 'center' }}>
          {candidate.platform === 'android'
            ? <AndroidRoundedIcon color="primary" fontSize="medium" />
            : <DesktopWindowsRoundedIcon color="primary" fontSize="medium" />}
          {candidate.platform === 'android' ? 'Take PrintStream with you' : 'PrintStream for Windows'}
        </DialogTitle>
        <DialogContent sx={{ m: 0 }}>
          <Typography level="body-sm" textColor="text.tertiary">
            {candidate.platform === 'android'
              ? 'Keep printers, jobs, and your library close at hand with native notifications and saved server connections.'
              : 'Keep printers, jobs, and your library close at hand with native notifications, saved server connections, and model-site browsing.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ pt: 0 }}>
          <Button variant="plain" color="neutral" onClick={dismiss}>Not now</Button>
          <Button
            variant="solid"
            color="primary"
            startDecorator={<DownloadRoundedIcon />}
            onClick={() => {
              dismiss()
              onBrowseDownloads()
            }}
          >
            View app downloads
          </Button>
        </DialogActions>
      </ModalDialog>
    </BackAwareModal>
  )
}
