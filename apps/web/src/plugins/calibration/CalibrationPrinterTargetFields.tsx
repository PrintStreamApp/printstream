/** Hardware applicability editor shared by measured, manual and edited saved calibrations. */
import { FormControl, FormLabel, Option, Select, Stack, Typography } from '@mui/joy'
import { printerModelSchema, type CalibrationPrinterTarget, type Printer } from '@printstream/shared'
import { DeferredKeyboardAutocomplete } from '../../components/DeferredKeyboardAutocomplete'

/** Model rules survive printer replacement; named-printer rules never broaden when a printer disappears. */
export function CalibrationPrinterTargetFields({ value, onChange, printers, defaultModel, defaultPrinterId }: {
  value: CalibrationPrinterTarget
  onChange: (value: CalibrationPrinterTarget) => void
  printers: Printer[]
  defaultModel: string
  defaultPrinterId?: string | null
}) {
  const models = [...new Set([...printerModelSchema.options.filter((model) => model !== 'unknown'), defaultModel])].filter(Boolean)
  const byId = new Map(printers.map((printer) => [printer.id, printer]))
  return (
    <Stack spacing={1}>
      <FormControl>
        <FormLabel>Applies to</FormLabel>
        <Select value={value.scope} onChange={(_event, scope) => {
          if (scope === 'models') onChange({ scope, models: defaultModel ? [defaultModel] : [] })
          if (scope === 'printers') onChange({ scope, printerIds: defaultPrinterId ? [defaultPrinterId] : [] })
        }}>
          <Option value="models">Selected printer models</Option>
          <Option value="printers">Specific printers</Option>
        </Select>
      </FormControl>
      {value.scope === 'models' ? (
        <FormControl required>
          <FormLabel>Models</FormLabel>
          <DeferredKeyboardAutocomplete multiple options={models} value={value.models}
            onChange={(_event, values) => onChange({ scope: 'models', models: values })} />
        </FormControl>
      ) : (
        <FormControl required>
          <FormLabel>Printers</FormLabel>
          <DeferredKeyboardAutocomplete multiple options={[...new Set([...byId.keys(), ...value.printerIds])]} value={value.printerIds}
            getOptionLabel={(id) => byId.has(id) ? `${byId.get(id)!.name} (${byId.get(id)!.model})` : 'Unavailable printer'}
            onChange={(_event, printerIds) => onChange({ scope: 'printers', printerIds })} />
        </FormControl>
      )}
      <Typography level="body-xs">Nozzle size must also match. Specific-printer calibrations take priority over model calibrations.</Typography>
    </Stack>
  )
}
