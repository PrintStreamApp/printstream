/**
 * Settings panel for the print-queue plugin, shown in the plugin manager.
 * Controls how the matcher and "Start all idle" behave: whether a required filament
 * may match on type alone (ignoring color), and the load-balancing strategy.
 */
import { useEffect, useState } from 'react'
import { Button, FormControl, FormHelperText, FormLabel, Option, Select, Stack, Switch, Typography } from '@mui/joy'
import type { QueueSettings } from '@printstream/shared'
import { toast } from '../../lib/toast'
import { useQueueSettingsQuery, useSaveQueueSettings } from './api'

export function SettingsPanel() {
  const settingsQuery = useQueueSettingsQuery(true)
  const saveSettings = useSaveQueueSettings()
  const [draft, setDraft] = useState<QueueSettings | null>(null)

  useEffect(() => {
    if (settingsQuery.data) setDraft(settingsQuery.data.settings)
  }, [settingsQuery.data])

  if (!draft) {
    return <Typography level="body-sm">Loading queue settings…</Typography>
  }

  const save = async () => {
    try {
      await saveSettings.mutateAsync(draft)
      toast.success('Queue settings saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save queue settings')
    }
  }

  return (
    <Stack spacing={2}>
      <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
        <Stack>
          <FormLabel>Allow type-only filament match</FormLabel>
          <FormHelperText>Match a required filament by type when no exact color is loaded.</FormHelperText>
        </Stack>
        <Switch
          checked={draft.allowTypeOnlyMatch}
          onChange={(event) => setDraft({ ...draft, allowTypeOnlyMatch: event.target.checked })}
        />
      </FormControl>

      <FormControl>
        <FormLabel>Load balancing</FormLabel>
        <Select
          value={draft.loadBalance}
          onChange={(_event, value) => value && setDraft({ ...draft, loadBalance: value })}
        >
          <Option value="idle-lru">Least recently used (spread wear)</Option>
          <Option value="sort-order">Printer dashboard order</Option>
        </Select>
        <FormHelperText>How the recommended printer and “Start all idle” pick among matching printers.</FormHelperText>
      </FormControl>

      <Stack direction="row" justifyContent="flex-end">
        <Button loading={saveSettings.isPending} onClick={save}>Save</Button>
      </Stack>
    </Stack>
  )
}
