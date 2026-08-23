/**
 * Which slicing engines this workspace shows its users.
 *
 * The hosted deployment installs every Bambu Studio version it supports,
 * because its users cannot install one themselves and a project saved by an
 * older Studio still has to be sliceable. That leaves a picker offering seven
 * versions to a workspace that only ever uses one, so a workspace hides the
 * ones it does not want to see.
 *
 * Presentation only. Hiding an engine takes it out of the pickers; it does not
 * refuse a slice that names it, because a project can carry a target chosen
 * before the engine was hidden and a dispatch failing with "unknown engine"
 * would be far worse than a list with one row too many.
 *
 * Unlike the install manager beside it, this exists on EVERY deployment: the
 * choice is about this workspace's own lists, so it never touches the shared
 * slicer and cannot affect another workspace.
 *
 * Counterpart: `apps/api/src/routes/slicing.ts` (`/api/slicing/engine-visibility`).
 */
import { Alert, Button, Card, CardContent, Checkbox, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, slicerEngineVisibilitySchema } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/apiClient'

const QUERY_KEY = ['slicing', 'engine-visibility']

export function SlicerEngineVisibilityCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string> | null>(null)

  const visibilityQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async ({ signal }) =>
      slicerEngineVisibilitySchema.parse(await apiFetch('/api/slicing/engine-visibility', { signal }))
  })

  const available = visibilityQuery.data?.available ?? []
  const storedIds = visibilityQuery.data?.visibleIds ?? null

  // Seeded from the server once loaded: null on the server means "all", which
  // shows as everything ticked rather than nothing.
  useEffect(() => {
    if (!visibilityQuery.data) return
    setSelected(new Set(storedIds ?? available.map((engine) => engine.id)))
    // `storedIds` is the value being seeded from; re-seeding on every render of
    // the same data would fight the user's clicks.
  }, [visibilityQuery.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (ids: string[]) => apiFetch<void>('/api/slicing/engine-visibility', {
      method: 'PUT',
      // Everything ticked is stored as "no choice", so a workspace that ticks
      // them all keeps picking up engines added later instead of freezing its
      // list to today's set.
      body: { visibleIds: ids.length === available.length ? [] : ids }
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      // The pickers read their targets from capabilities, which this changes.
      await queryClient.invalidateQueries({ queryKey: ['slicing-capabilities'] })
    }
  })

  if (visibilityQuery.isPending || !selected) return null
  // Nothing to choose between: one engine is not a list worth curating.
  if (available.length < 2) return null

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = [...selected]
  // Never zero: a workspace with no visible engine cannot slice and cannot fix
  // it from the slice dialog. The server falls back to showing everything, but
  // refusing the save says so instead of silently doing something else.
  const nothingChosen = chosen.length === 0

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack spacing={0.5}>
            <Typography level="title-sm">Engines this workspace shows</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              Hide the Bambu Studio versions you never slice with. This only changes the lists your
              workspace sees: projects that already name a hidden version still slice.
            </Typography>
          </Stack>

          <Stack spacing={0.5}>
            {available.map((engine) => (
              <Checkbox
                key={engine.id}
                size="sm"
                disabled={!canManage || save.isPending}
                checked={selected.has(engine.id)}
                onChange={() => toggle(engine.id)}
                label={engine.label}
              />
            ))}
          </Stack>

          {nothingChosen ? (
            <Alert color="warning" variant="soft">
              Keep at least one engine visible, or nobody here can slice.
            </Alert>
          ) : null}
          {save.isError ? (
            <Alert color="danger" variant="soft">
              {extractErrorMessage(save.error, 'Could not save which engines are shown.')}
            </Alert>
          ) : null}

          {canManage ? (
            <Button
              size="sm"
              // Outlined, matching the engine manager below it. `plain` is the
              // record-card convention; on a settings card it is the only
              // control in the box and reads as a label rather than a button.
              variant="outlined"
              loading={save.isPending}
              disabled={nothingChosen}
              onClick={() => save.mutate(chosen)}
              sx={{ alignSelf: 'flex-start' }}
            >
              Save
            </Button>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  )
}
