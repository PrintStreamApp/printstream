/**
 * Material usage and source-paint removal guard for one editor session.
 *
 * Paint mutates the scene in place, so a committed stroke increments a
 * revision that invalidates both usage and source evidence. Until the pinned
 * archive scan and scene merge succeed, source materials stay guarded.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { randomUUID } from '../../lib/randomId'
import type { EditorState } from './lib/editorModel'
import type { EditorProjectSource } from './lib/editorProjectSource'
import {
  editorMaterialUsage,
  liveSourceColorPaintMaterialIds,
  sourceColorPaintMaterialIds,
  unverifiedSourceMaterialIds
} from './lib/materialReplacement'
import type { useEditorProjectSession } from './useEditorProjectSession'

type Options = {
  state: EditorState | null
  sliceConfig?: SliceSettingsController
  platesQuery: ReturnType<typeof useEditorProjectSession>['platesQuery']
  projectSource: EditorProjectSource
  hasNoBaseFile: boolean
}

/** Keep material summaries and deletion safety in sync with live paint. */
export function useEditorMaterialUsage({ state, sliceConfig, platesQuery, projectSource, hasNoBaseFile }: Options) {
  const bakedSupportFilamentIds = platesQuery.data?.supportFilamentIds
  const sessionSupportOverrides = sliceConfig?.perObjectSettings
  // Paint mutates `EditorState` IN PLACE (a clone per pointer-move would be brutal), so the state
  // object's identity does not change when a stroke lands, and the usage memo below is keyed on
  // it. This revision is bumped once per committed stroke (and by clear-paint) so the used-material
  // set re-derives: without it a painted material stayed "unused" (removable, and no prime tower)
  // until some unrelated edit happened to replace the state object.
  const [paintRevision, setPaintRevision] = useState(0)
  const paintCommittedRef = useRef<(() => void) | null>(null)
  paintCommittedRef.current = () => setPaintRevision((revision) => revision + 1)
  const usageKey = useMemo(() => {
    const { objectIds, supportIds } = editorMaterialUsage({
      state,
      sessionIds: sliceConfig?.projectFilaments.map((filament) => filament.projectFilamentId) ?? [],
      bakedSupportIds: bakedSupportFilamentIds,
      processOverrides: sessionSupportOverrides
    })
    const sortJoin = (ids: Set<number>) => [...ids].sort((left, right) => left - right).join(',')
    return `${sortJoin(objectIds)}|${sortJoin(supportIds)}`
    // `paintRevision` is an INVALIDATION KEY, not a value this body reads: paint mutates the state
    // object in place, so its identity cannot signal a stroke (see the revision's declaration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, paintRevision, bakedSupportFilamentIds, sessionSupportOverrides, sliceConfig?.projectFilaments])
  const { usedFilamentIds, supportOnlyFilamentIds } = useMemo(() => {
    const [objectStr = '', supportStr = ''] = usageKey.split('|')
    const objectIds = new Set(objectStr ? objectStr.split(',').map(Number) : [])
    const supportIds = new Set(supportStr ? supportStr.split(',').map(Number) : [])
    return {
      usedFilamentIds: new Set<number>([...objectIds, ...supportIds]),
      supportOnlyFilamentIds: new Set<number>([...supportIds].filter((id) => !objectIds.has(id)))
    }
  }, [usageKey])
  // The local editor has no library file id. Give each opened source its own cache entry so paint
  // evidence from a previous local file cannot mark this file safe to remove a material from.
  const sourcePaintScanKey = useMemo(randomUUID, [projectSource])
  const [sourceScenesReadyFor, setSourceScenesReadyFor] = useState<EditorProjectSource | null>(null)
  const sourcePaintQuery = useQuery({
    queryKey: ['library-editor-source-paint-materials', sourcePaintScanKey],
    enabled: !hasNoBaseFile && platesQuery.isSuccess,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      // Cached plate data can be ready before this source has opened its archive, notably after
      // a dev hot reload. Open the pinned source instead of marking paint evidence failed forever.
      await projectSource.loadIndex()
      const archive = projectSource.archive()
      if (!archive) throw new Error('The source archive is not ready for a colour-paint scan.')
      return sourceColorPaintMaterialIds(archive)
    }
  })
  useEffect(() => {
    if (sourcePaintQuery.isError) {
      console.warn('[editor] source colour-paint scan failed; material removal remains guarded', sourcePaintQuery.error)
    }
  }, [sourcePaintQuery.isError, sourcePaintQuery.error])
  const unverifiedFilamentIds = useMemo(() => unverifiedSourceMaterialIds(
    hasNoBaseFile ? [] : platesQuery.data?.projectFilaments.map((filament) => filament.id),
    state?.baseFilamentIds,
    sliceConfig?.projectFilaments.map((filament) => filament.projectFilamentId) ?? [],
    sourcePaintQuery.isSuccess && sourceScenesReadyFor === projectSource
      ? liveSourceColorPaintMaterialIds(state, sourcePaintQuery.data)
      : undefined
    // Paint maps mutate in place, so the revision invalidates the source guard too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [hasNoBaseFile, platesQuery.data, state, paintRevision, sliceConfig?.projectFilaments, sourcePaintQuery.isSuccess, sourcePaintQuery.data, sourceScenesReadyFor, projectSource])
  return {
    usedFilamentIds,
    supportOnlyFilamentIds,
    unverifiedFilamentIds,
    paintCommittedRef,
    setSourceScenesReadyFor
  }
}
