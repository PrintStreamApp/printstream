/**
 * Quick "adjust remaining" dialog — a weigh-in or refill that sets an absolute
 * remaining gram value and appends a manual ledger entry. Handy for non-Bambu
 * spools whose remaining is tracked from print consumption and occasionally
 * needs a correction.
 */
import { useEffect, useState } from 'react'
import { Alert, Box, Button, DialogContent, DialogTitle, FormControl, FormLabel, Input, ModalDialog, Typography } from '@mui/joy'
import { extractErrorMessage, type FilamentSpool } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { spoolTitle } from './filters'
import { useSpoolMutations } from './api'

export function SpoolAdjustDialog({ spool, onClose }: { spool: FilamentSpool | null; onClose: () => void }) {
  const { adjust } = useSpoolMutations()
  const [grams, setGrams] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (spool) {
      setGrams(String(Math.round(spool.remainingGrams)))
      setError(null)
    }
  }, [spool])

  const submit = async () => {
    if (!spool) return
    setError(null)
    const value = Number(grams)
    if (Number.isNaN(value) || value < 0) {
      setError('Enter the remaining grams as a non-negative number.')
      return
    }
    try {
      await adjust.mutateAsync({ id: spool.id, input: { remainingGrams: value, note: 'Manual adjustment' } })
      onClose()
    } catch (caught) {
      setError(extractErrorMessage(caught, 'Could not adjust the spool.'))
    }
  }

  return (
    <Modal open={spool != null} onClose={onClose}>
      <ModalDialog variant="outlined" sx={{ width: { xs: '100%', sm: 420 }, maxWidth: '100%' }}>
        <DialogTitle>Adjust remaining</DialogTitle>
        <DialogContent>
          {spool && <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>{spoolTitle(spool)}</Typography>}
          {error && <Alert color="danger" variant="soft" sx={{ mb: 1 }}>{error}</Alert>}
          <FormControl>
            <FormLabel>Remaining filament (g)</FormLabel>
            <Input type="number" autoFocus value={grams} onChange={(e) => setGrams(e.target.value)} />
          </FormControl>
        </DialogContent>
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={adjust.isPending}>Cancel</Button>
          <Button color="primary" loading={adjust.isPending} onClick={() => void submit()}>Save</Button>
        </Box>
      </ModalDialog>
    </Modal>
  )
}
