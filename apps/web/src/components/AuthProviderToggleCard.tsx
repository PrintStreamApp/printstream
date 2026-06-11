import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { Alert, Card, CardContent, FormControl, Stack, Switch, Typography } from '@mui/joy'
import React from 'react'

/** Shared workspace-scoped auth-provider enable/disable card. */
export function AuthProviderToggleCard({
  title,
  description,
  helperText,
  checked,
  disabled = false,
  errorMessage = null,
  onChange
}: {
  title: string
  description: string
  helperText: string
  checked: boolean
  disabled?: boolean
  errorMessage?: string | null
  onChange: (checked: boolean) => void
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', gap: 2, alignItems: 'center' }}>
            <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
              <Typography level="title-sm">{title}</Typography>
              <Typography level="body-sm" textColor="text.tertiary">
                {description}
              </Typography>
            </Stack>
            <Switch
              checked={checked}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked)}
            />
          </FormControl>

          {errorMessage && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {errorMessage}
            </Alert>
          )}

          <Stack direction="row" spacing={0.75} alignItems="flex-start">
            {checked ? (
              <CheckCircleOutlineRoundedIcon fontSize="small" color="success" />
            ) : (
              <InfoOutlinedIcon fontSize="small" color="disabled" />
            )}
            <Typography level="body-xs" textColor="text.tertiary">
              {helperText}
            </Typography>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}