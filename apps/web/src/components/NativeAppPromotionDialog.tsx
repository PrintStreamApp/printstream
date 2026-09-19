/** One-time browser promotion for the matching released native client after sign-in. */
import AndroidRoundedIcon from '@mui/icons-material/AndroidRounded'
import DesktopWindowsRoundedIcon from '@mui/icons-material/DesktopWindowsRounded'
import { Button, DialogActions, DialogContent, DialogTitle, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy'
import { useEffect, useRef, useState } from 'react'
import React from 'react'
import { isAppBusy, subscribeAppBusy } from '../lib/appBusy'
import {
  detectNativeAppPromotion,
  dismissNativeAppPromotion,
  isNativeAppPromotionDismissed,
  takeNativeAppPromotionAfterSignInFlag,
  type NativeAppPromotion
} from '../lib/nativeAppPromotion'
import { isNativeApp } from '../native/bridge'
import { BackAwareModal } from './BackAwareModal'

export function NativeAppPromotionDialog({ authenticated }: { authenticated: boolean }) {
  const evaluated = useRef(false)
  const [candidate, setCandidate] = useState<NativeAppPromotion | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!authenticated || evaluated.current) return
    evaluated.current = true

    if (!takeNativeAppPromotionAfterSignInFlag() || isNativeApp()) return
    const promotion = detectNativeAppPromotion()
    if (!promotion || isNativeAppPromotionDismissed(promotion.platform)) return
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
    dismissNativeAppPromotion(candidate.platform)
    setOpen(false)
    setCandidate(null)
  }

  return (
    <BackAwareModal open={open} onClose={dismiss}>
      <ModalDialog variant="outlined" sx={{ width: 'min(440px, 100%)' }}>
        <ModalClose />
        <DialogTitle>Take PrintStream with you</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {candidate.platform === 'android'
              ? <AndroidRoundedIcon color="primary" fontSize="large" />
              : <DesktopWindowsRoundedIcon color="primary" fontSize="large" />}
            <Typography level="body-sm" textColor="text.tertiary">
              Get the PrintStream app for {candidate.platformLabel} for quicker access, saved connections, and native notifications.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={dismiss}>Not now</Button>
          <Button
            component="a"
            href={candidate.storeUrl}
            target="_blank"
            rel="noreferrer"
            onClick={dismiss}
          >
            {candidate.storeLabel}
          </Button>
        </DialogActions>
      </ModalDialog>
    </BackAwareModal>
  )
}
