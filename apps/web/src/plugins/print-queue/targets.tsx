/**
 * Target-printer select for the queue add flows: the encoded
 * `any` / `printer:<id>` / `model:<model>` value. `decodeTarget` (in
 * QueueItemDialog) turns the value into the shared `QueueTarget` contract.
 */
import { useMemo } from 'react'
import { Option, Select } from '@mui/joy'
import type { Printer } from '@printstream/shared'

export function TargetSelect({ printers, value, onChange }: { printers: Printer[]; value: string; onChange: (value: string) => void }) {
  const models = useMemo(() => Array.from(new Set(printers.map((printer) => printer.model))).sort(), [printers])
  return (
    <Select value={value} onChange={(_event, next) => onChange(next ?? 'any')}>
      <Option value="any">Any eligible printer</Option>
      {printers.map((printer) => (
        <Option key={printer.id} value={`printer:${printer.id}`}>{printer.name}</Option>
      ))}
      {models.map((model) => (
        <Option key={model} value={`model:${model}`}>{`Any ${model}`}</Option>
      ))}
    </Select>
  )
}
