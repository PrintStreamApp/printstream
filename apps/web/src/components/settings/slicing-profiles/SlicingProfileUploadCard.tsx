/**
 * The preset upload control for the slicing-profile manager.
 *
 * The server reports a same-name collision as a 409 rather than replacing silently, so an
 * overwrite is always the user's explicit second decision — the retry re-posts with
 * `overwrite: true`.
 */
import React from 'react'
import { Alert, Box, Button, Card, CardContent, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, type SlicingProfileResponse } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from '../../../lib/apiClient'
import { usePromptDialog } from '../../PromptDialogProvider'
import { buildSlicingProfileUpload } from './slicingProfileUpload'

export function SlicingProfileUploadCard(): JSX.Element {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = React.useState<string | null>(null)

  const uploadProfile = useMutation({
    // The 409 conflict is part of the normal flow and handled below, so opt out of the global
    // mutation-error toast.
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async ({ file, overwrite }: { file: File; overwrite?: boolean }) =>
      await apiFetch<SlicingProfileResponse>('/api/slicing/profiles', {
        method: 'POST',
        body: await buildSlicingProfileUpload(file, overwrite)
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
    }
  })

  async function handleUploadFile(file: File) {
    setUploadError(null)
    try {
      await uploadProfile.mutateAsync({ file })
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) {
        setUploadError(extractErrorMessage(error))
        return
      }
      const conflicts = Array.isArray((error.payload as { conflicts?: unknown })?.conflicts)
        ? (error.payload as { conflicts: string[] }).conflicts
        : []
      const confirmed = await confirm({
        title: 'Replace existing presets?',
        description: conflicts.length > 0
          ? (
            <Stack spacing={0.75}>
              <Typography level="body-sm">
                Uploading "{file.name}" will overwrite {conflicts.length > 1 ? 'these existing presets' : 'this existing preset'}:
              </Typography>
              <Stack spacing={0.25}>
                {conflicts.map((name) => (
                  <Typography key={name} level="body-sm" sx={{ fontWeight: 'lg' }}>{name}</Typography>
                ))}
              </Stack>
            </Stack>
          )
          : `Uploading "${file.name}" will overwrite an existing preset.`,
        confirmLabel: 'Replace',
        color: 'warning'
      })
      if (!confirmed) return
      try {
        await uploadProfile.mutateAsync({ file, overwrite: true })
      } catch (retryError) {
        setUploadError(extractErrorMessage(retryError))
      }
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
            <Stack spacing={0.5}>
              <Typography level="title-sm">Upload BambuStudio presets</Typography>
              <Typography level="body-sm" textColor="text.tertiary">
                Upload `.json`, `.bbscfg`, `.bbsflmt`, or preset `.zip` exports. Profile kinds are auto-detected from the file using BambuStudio's own preset rules.
              </Typography>
            </Stack>
            <Button loading={uploadProfile.isPending} onClick={() => inputRef.current?.click()}>
              Upload presets
            </Button>
          </Stack>
          <Box
            component="input"
            type="file"
            accept="application/json,.json,.bbscfg,.bbsflmt,.zip"
            ref={inputRef}
            sx={{ display: 'none' }}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (!file) return
              void handleUploadFile(file)
            }}
          />
          {uploadError && <Alert color="danger">{uploadError}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  )
}
