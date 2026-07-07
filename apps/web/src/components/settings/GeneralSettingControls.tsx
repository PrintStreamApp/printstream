/**
 * Building blocks for "general settings" cards: a titled card with an
 * optional reset action, a label + helper + right-aligned select row, and
 * the notice shown when a device override is shadowing the shared default.
 * Shared by the workspace Settings view and the Platform workspace.
 */
import React from 'react'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import { Box, Button, Card, CardContent, FormControl, FormLabel, Stack, Typography } from '@mui/joy'

export function GeneralSettingCard({
  title,
  description,
  onReset,
  resetDisabled = false,
  children
}: {
  title: string
  description: string
  /** When provided, a "Reset to default" button is shown opposite the title. */
  onReset?: () => void
  resetDisabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
            <Box sx={{ minWidth: 0 }}>
              <Typography level="title-md">{title}</Typography>
              <Typography level="body-sm" textColor="text.tertiary">
                {description}
              </Typography>
            </Box>
            {onReset && (
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                startDecorator={<RestartAltRoundedIcon />}
                disabled={resetDisabled}
                onClick={onReset}
                sx={{ flexShrink: 0 }}
              >
                Reset to default
              </Button>
            )}
          </Stack>
          <Stack spacing={1.25}>
            {children}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}

export function GeneralSettingSelectRow({
  label,
  helper,
  children
}: {
  label: string
  helper: string
  children: React.ReactNode
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      justifyContent="space-between"
    >
      <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
        <FormLabel>{label}</FormLabel>
        <Typography level="body-xs" textColor="text.tertiary">
          {helper}
        </Typography>
      </Stack>
      <FormControl size="sm" sx={{ width: { xs: '100%', sm: 240 }, flexShrink: 0 }}>
        {children}
      </FormControl>
    </Stack>
  )
}

export function DeviceOverrideNotice({ message, onClear }: { message: string; onClear: () => void }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Typography level="body-xs" textColor="text.tertiary">
        {message}
      </Typography>
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onClear}
      >
        Use shared setting on this device
      </Button>
    </Stack>
  )
}
