/**
 * Barcode entry for packaged filament and labelled spools. The camera decoder is loaded only
 * while this dialog is open, keeping ZXing out of the ordinary app shell. Hardware barcode
 * readers and browsers without camera access use the same code field and lookup path.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, FormControl, FormLabel, Input, Sheet, Stack, Typography } from '@mui/joy'
import CameraAltRoundedIcon from '@mui/icons-material/CameraAltRounded'
import type { FilamentBarcodeProduct } from '@printstream/shared'
import type { IScannerControls } from '@zxing/browser'
import { extractErrorMessage } from '@printstream/shared'
import { FormDialog } from '../../components/FormDialog'
import { lookupFilamentBarcode } from './api'

export function SpoolBarcodeDialog({
  open,
  onClose,
  onResolved
}: {
  open: boolean
  onClose: () => void
  onResolved: (product: FilamentBarcodeProduct) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const lastCameraCodeRef = useRef<string | null>(null)
  const lookingUpRef = useRef(false)
  const [code, setCode] = useState('')
  const [cameraNotice, setCameraNotice] = useState<string | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)

  const resolveCode = useCallback(async (rawCode: string) => {
    const trimmed = rawCode.trim()
    if (!trimmed || lookingUpRef.current) return
    lookingUpRef.current = true
    setLookingUp(true)
    setLookupError(null)
    try {
      const result = await lookupFilamentBarcode(trimmed)
      if (!result.product) {
        setLookupError('This barcode does not identify one filament product in the catalog. Try the retail UPC/EAN or the five-digit Bambu filament code.')
        return
      }
      controlsRef.current?.stop()
      onResolved(result.product)
      onClose()
    } catch (error) {
      setLookupError(extractErrorMessage(error, 'Could not look up this barcode.'))
    } finally {
      lookingUpRef.current = false
      setLookingUp(false)
    }
  }, [onClose, onResolved])

  useEffect(() => {
    if (!open) return
    setCode('')
    setLookupError(null)
    setCameraNotice(null)
    lastCameraCodeRef.current = null

    let cancelled = false
    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraNotice('Camera scanning is unavailable in this browser. Enter the number printed under the barcode instead.')
        return
      }
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        if (cancelled || !videoRef.current) return
        const reader = new BrowserMultiFormatReader()
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } }, audio: false },
          videoRef.current,
          (result) => {
            if (!result || lookingUpRef.current) return
            const scanned = result.getText().trim()
            if (!scanned || scanned === lastCameraCodeRef.current) return
            lastCameraCodeRef.current = scanned
            setCode(scanned)
            void resolveCode(scanned)
          }
        )
        // Closing while permission or camera startup is pending runs cleanup before controls exist.
        // Stop the late result here so it cannot leave an orphaned camera stream behind.
        if (cancelled) {
          controls.stop()
          return
        }
        controlsRef.current = controls
      } catch {
        if (!cancelled) {
          setCameraNotice('Camera access was unavailable. Enter the number printed under the barcode instead.')
        }
      }
    }
    void startCamera()

    return () => {
      cancelled = true
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [open, resolveCode])

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      busy={lookingUp}
      title="Scan filament"
      description="Scan a retail UPC/EAN or five-digit Bambu filament code. PrintStream identifies the product and prefills its spool details for review."
      error={lookupError}
      submitLabel="Look up code"
      submitDisabled={!code.trim()}
      onSubmit={() => void resolveCode(code)}
      width="min(560px, 100%)"
    >
      <Sheet
        variant="outlined"
        sx={{ overflow: 'hidden', borderRadius: 'md', bgcolor: 'background.level1', aspectRatio: '4 / 3' }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Barcode camera preview"
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </Sheet>
      {cameraNotice ? <Alert variant="soft">{cameraNotice}</Alert> : null}
      <Stack spacing={0.5}>
        <FormControl>
          <FormLabel>Barcode or product code</FormLabel>
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void resolveCode(code)
              }
            }}
            startDecorator={<CameraAltRoundedIcon />}
            placeholder="Scan or enter the printed code"
          />
        </FormControl>
        <Typography level="body-xs" textColor="text.tertiary">
          USB and Bluetooth barcode readers can type into this field directly.
        </Typography>
      </Stack>
    </FormDialog>
  )
}
