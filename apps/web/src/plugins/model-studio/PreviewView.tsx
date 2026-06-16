import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Chip, CircularProgress, DialogContent, DialogTitle, Divider, IconButton, ModalClose, Sheet, Slider, Stack, Switch, Typography, Tooltip } from '@mui/joy'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import { useQuery } from '@tanstack/react-query'
import type { LibraryFile, LibraryThreeMfScene, ThreeMfIndex } from '@printstream/shared'
import * as THREE from 'three'
import { OrbitControls, STLLoader } from 'three-stdlib'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { buildLayeredGcodePreview, GCODE_FEATURE_COLORS, GCODE_FEATURE_NAMES, parseGcodeLayers, type GcodeStats, type LayeredGcodePreview } from './lib/gcodePreview'
import { formatSecondsDuration } from '../../lib/time'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { LibraryPlateCardPicker } from '../../components/LibraryPlateSelect'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import {
  createPreviewPlateSurface,
  createThreeMfMatrix,
  createThreeMfPartObject,
  disposeObject3D,
  parseThreeMfModelEntry
} from './lib/threeMfScene'
import {
  BAMBU_THREE_MF_ISO_UP,
  VIEW_CUBE_SIZE,
  VIEW_PRESET_CONFIG,
  computePlatedOrthoFrameRadius,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'

const PLATED_PREVIEW_GRID_SIZE = 320

/**
 * Modal 3D previewer for STL files, plated 3MF projects, and
 * plate-scoped printer-ready 3MF/G-code files.
 */
export function PreviewView(props: Record<string, unknown>) {
  const fileId = typeof props.previewFileId === 'string' ? props.previewFileId : null
  // Archived-version mode: read the version's bytes through the versioned
  // resource routes and take the file metadata from the caller (there is no
  // version-detail endpoint) so nothing touches the current file.
  const versionId = typeof props.previewVersionId === 'string' ? props.previewVersionId : null
  const fileOverride = (props.previewFile as LibraryFile | undefined) ?? null
  const resourceBase = versionId ? `/api/library/versions/${versionId}` : `/api/library/${fileId}`
  const requestedPlateIndex = typeof props.previewPlateIndex === 'number' && Number.isInteger(props.previewPlateIndex) && props.previewPlateIndex > 0
    ? props.previewPlateIndex
    : null
  const onClose = typeof props.onPreviewClose === 'function' ? props.onPreviewClose as (() => void) : undefined
  const open = Boolean(fileId)
  const [viewerContainer, setViewerContainer] = useState<HTMLDivElement | null>(null)
  const [viewCubeContainer, setViewCubeContainer] = useState<HTMLDivElement | null>(null)
  const [selectedPlate, setSelectedPlate] = useState(1)
  const [viewerState, setViewerState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null
  })
  const applyViewPresetRef = useRef<((preset: ViewPreset) => void) | null>(null)
  // Layered G-code preview (sliced-file navigation): the built preview is held in a ref
  // so the layer slider adjusts draw ranges without re-running the heavy viewer effect.
  const gcodePreviewRef = useRef<LayeredGcodePreview | null>(null)
  const [gcodeLayerCount, setGcodeLayerCount] = useState(0)
  const [gcodeTopLayer, setGcodeTopLayer] = useState(0)
  const [gcodeSingleLayer, setGcodeSingleLayer] = useState(false)
  // Within-layer scrub (Bambu's horizontal move slider): null shows the whole top layer.
  const [gcodeMoveCount, setGcodeMoveCount] = useState(0)
  const [gcodeMoveEnd, setGcodeMoveEnd] = useState<number | null>(null)
  // Time/usage breakdown parsed from the plate's G-code (BS-style stats panel).
  const [gcodeStats, setGcodeStats] = useState<GcodeStats | null>(null)
  const [gcodeStatsOpen, setGcodeStatsOpen] = useLocalStorageState(
    'bambu.preview.gcodeStatsOpen',
    true,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // Collapsed plate strip (name-only chips, no thumbnails) mirrors the editor's
  // bambu.editor.plateStripCollapsed preference but is tracked separately.
  const [plateStripCollapsed, setPlateStripCollapsed] = useLocalStorageState(
    'bambu.preview.plateStripCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )

  const fileQuery = useQuery({
    queryKey: ['library-preview-file', fileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${fileId}`, { signal }),
    enabled: open && !fileOverride
  })
  const file = fileOverride ?? fileQuery.data?.file ?? null
  const previewMode = useMemo(() => resolvePreviewMode(file), [file])
  const platesQuery = useQuery({
    queryKey: ['library-preview-plates', fileId ?? 'missing', versionId ?? 'current'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBase}/plates`, { signal }),
    enabled: Boolean(open && fileId && !isMeshPreviewMode(previewMode)),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const sceneQuery = useQuery({
    queryKey: ['library-preview-scene', fileId ?? 'missing', versionId ?? 'current', selectedPlate],
    queryFn: ({ signal }) => apiFetch<LibraryThreeMfScene>(`${resourceBase}/scene?plate=${selectedPlate}`, { signal }),
    // Fetched for the plated 3MF scene AND the G-code preview: the G-code path renders
    // toolpaths, but reads the scene's `bed` to draw the printer's true plate (size +
    // nozzle-only exclude zones) instead of a generic square grid.
    enabled: Boolean(open && fileId && (previewMode === '3mf' || previewMode === 'plate-gcode')),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])

  useEffect(() => {
    setSelectedPlate(requestedPlateIndex ?? 1)
  }, [fileId, requestedPlateIndex])

  useEffect(() => {
    if (isMeshPreviewMode(previewMode)) {
      setSelectedPlate(1)
      return
    }
    if (plates.length === 0) {
      setSelectedPlate(requestedPlateIndex ?? 1)
      return
    }
    if (!plates.some((plate) => plate.index === selectedPlate)) {
      setSelectedPlate(plates[0]?.index ?? requestedPlateIndex ?? 1)
    }
  }, [plates, previewMode, requestedPlateIndex, selectedPlate])

  useEffect(() => {
    if (!open || !viewerContainer || !viewCubeContainer) return

    const isThreeMfScene = previewMode === '3mf'
    const isPlatedPreview = previewMode === '3mf' || previewMode === 'plate-gcode'

    if (
      fileQuery.isLoading
      || (!isMeshPreviewMode(previewMode) && platesQuery.isLoading)
      // Wait for the scene on both plated modes so the bed is known before the first draw.
      || (isPlatedPreview && sceneQuery.isLoading)
    ) {
      setViewerState({ loading: true, error: null })
      return
    }

    if (fileQuery.error instanceof Error) {
      setViewerState({ loading: false, error: fileQuery.error.message })
      return
    }

    if (isThreeMfScene && sceneQuery.error instanceof Error) {
      setViewerState({ loading: false, error: sceneQuery.error.message })
      return
    }

    if (!fileId || !file || !previewMode) {
      if (fileQuery.isSuccess) {
        setViewerState({ loading: false, error: '3D preview is only available for STL and 3MF library files.' })
      }
      return
    }

    const container = viewerContainer
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0d1322')

    const initialAspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    // Only the plated 3MF scene uses an orthographic camera; the G-code preview uses a
    // perspective camera (45° FOV) so it matches the full editor's camera, not a flat ortho view.
    const useOrthographicCamera = isThreeMfScene
    const camera = useOrthographicCamera
      ? new THREE.OrthographicCamera(-initialAspect, initialAspect, 1, -1, 0.1, 5000)
      : new THREE.PerspectiveCamera(45, initialAspect, 0.1, 5000)
    if (isPlatedPreview) {
      camera.up.set(BAMBU_THREE_MF_ISO_UP.x, BAMBU_THREE_MF_ISO_UP.y, BAMBU_THREE_MF_ISO_UP.z)
    }
    camera.position.set(150, 150, 200)

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: isPlatedPreview })
    renderer.setPixelRatio(window.devicePixelRatio || 1)
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    renderer.shadowMap.enabled = isThreeMfScene
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.28
    controls.enablePan = true

    let platedFrameRadius = 1
    let platedContentSize: THREE.Vector3 | null = null
    let viewDistance = 200

    const applyPlatedOrthoProjection = () => {
      if (!(camera instanceof THREE.OrthographicCamera)) return
      const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
      const halfHeight = aspect >= 1 ? platedFrameRadius : platedFrameRadius / aspect
      const halfWidth = aspect >= 1 ? platedFrameRadius * aspect : platedFrameRadius
      camera.left = -halfWidth
      camera.right = halfWidth
      camera.top = halfHeight
      camera.bottom = -halfHeight
      camera.updateProjectionMatrix()
    }

    const applyViewPreset = (preset: ViewPreset) => {
      const config = VIEW_PRESET_CONFIG[preset]
      if (camera instanceof THREE.OrthographicCamera && platedContentSize) {
        const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
        platedFrameRadius = Math.max(computePlatedOrthoFrameRadius(platedContentSize, aspect, preset), 30)
        applyPlatedOrthoProjection()
      }
      camera.up.set(config.up.x, config.up.y, config.up.z)
      camera.position.set(
        viewDistance * config.direction.x,
        viewDistance * config.direction.y,
        viewDistance * config.direction.z
      )
      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
      controls.update()
    }

    applyViewPresetRef.current = applyViewPreset

    const viewCube = createViewCube(viewCubeContainer, (preset) => {
      applyViewPreset(preset)
      viewCube.sync(camera)
    })
    const syncViewCubeOrientation = () => {
      viewCube.sync(camera)
    }

    scene.add(new THREE.HemisphereLight(0xffffff, isPlatedPreview ? 0x5d646b : 0x202030, isPlatedPreview ? 1.05 : 0.9))
    const dir = new THREE.DirectionalLight(0xffffff, isPlatedPreview ? 0.5 : 0.6)
    dir.position.set(1, 1, 1)
    if (isThreeMfScene) {
      dir.castShadow = true
      dir.shadow.mapSize.set(2048, 2048)
      dir.shadow.camera.near = 50
      dir.shadow.camera.far = 800
      dir.shadow.camera.left = -260
      dir.shadow.camera.right = 260
      dir.shadow.camera.top = 260
      dir.shadow.camera.bottom = -260
      dir.shadow.bias = -0.0004
      dir.shadow.normalBias = 0.04
    }
    scene.add(dir)
    let stlGrid: THREE.GridHelper | null = null
    if (!isPlatedPreview) {
      // THREE.GridHelper lies in the XZ plane (Three's default Y-up world). This
      // preview is Z-up (applyViewPreset('iso') sets camera.up to +Z), so an
      // unrotated grid stands up as a vertical wall beside the model. Rotate it
      // into the XY plane so it reads as a horizontal floor; it is lowered to the
      // model's base once the mesh loads (size is unknown until then).
      stlGrid = new THREE.GridHelper(320, 16, 0x2a6f66, 0x223042)
      stlGrid.rotation.x = Math.PI / 2
      scene.add(stlGrid)
    } else {
      const keyLight = new THREE.DirectionalLight(0xfff2d8, 0.36)
      keyLight.position.set(-1.15, 0.8, 1.6)
      scene.add(keyLight)

      // Underside lift stays, but in near-neutral grey: the previous saturated
      // blues (0x7bc5ff / 0x5d98d1) tinted glossy angled faces visibly blue.
      const underLight = new THREE.DirectionalLight(0xb9c4cc, 0.12)
      underLight.position.set(-0.35, 0.2, -1)
      scene.add(underLight)

      const underFill = new THREE.AmbientLight(0x9aa4ad, 0.12)
      scene.add(underFill)
    }

    let previewObject: THREE.Object3D | null = null
    let cancelled = false
    const loadAbortController = new AbortController()

    const handleLoadError = (error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Unable to load the 3D preview.'
      setViewerState({ loading: false, error: message })
    }

    const attachObject = (object: THREE.Object3D) => {
      if (cancelled) {
        disposeObject3D(object)
        return
      }

      const box = new THREE.Box3().setFromObject(object)
      if (box.isEmpty()) {
        disposeObject3D(object)
        setViewerState({ loading: false, error: 'This file does not include previewable 3D data.' })
        return
      }

      const center = box.getCenter(new THREE.Vector3())
      object.position.sub(center)
      previewObject = object
      scene.add(object)

      const size = box.getSize(new THREE.Vector3())
      if (stlGrid) {
        // Rest the floor grid under the now-centred model.
        stlGrid.position.z = -size.z / 2
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const maxDimension = Math.max(size.x, size.y, size.z, 20)
      const distance = isPlatedPreview
        ? Math.max(sphere.radius * 3, maxDimension * 2, 120)
        : Math.max(maxDimension * 1.6, 80)
      viewDistance = distance
      if (camera instanceof THREE.OrthographicCamera) {
        platedContentSize = size.clone()
        camera.near = Math.max(distance / 20, 0.8)
        camera.far = Math.max(distance * 6, 1200)
      } else {
        camera.near = 0.1
        camera.far = Math.max(distance * 20, 5000)
        camera.updateProjectionMatrix()
      }
      applyViewPreset('iso')
      syncViewCubeOrientation()
      setViewerState({ loading: false, error: null })
    }

    setViewerState({ loading: true, error: null })
    // Reset the layered-G-code slider; it's repopulated when a plate's G-code loads.
    gcodePreviewRef.current = null
    setGcodeLayerCount(0)
    setGcodeStats(null)
    if (isMeshPreviewMode(previewMode)) {
      // STL ships verbatim from /download; STEP carries no mesh, so pull the server-tessellated
      // STL from /mesh (same BambuStudio-matched quality as importing the STEP into a project).
      const meshUrl = previewMode === 'step'
        ? buildApiUrl(`${resourceBase}/mesh`)
        : buildApiUrl(`${resourceBase}/download`)
      const loader = new STLLoader()
      loader.load(
        meshUrl,
        (geometry) => {
          geometry.computeVertexNormals()
          const material = new THREE.MeshStandardMaterial({ color: 0x1cab84, metalness: 0.1, roughness: 0.6 })
          attachObject(new THREE.Mesh(geometry, material))
        },
        undefined,
        handleLoadError
      )
    } else if (previewMode === 'plate-gcode') {
      void fetch(buildApiUrl(`${resourceBase}/plate-gcode?plate=${selectedPlate}`), {
        credentials: 'include',
        signal: loadAbortController.signal
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Failed to load G-code (HTTP ${response.status})`)
          return response.text()
        })
        .then((text) => {
          if (cancelled) return
          const parsed = parseGcodeLayers(text)
          if (parsed.layerCount === 0) throw new Error('This plate does not include previewable G-code geometry.')
          const preview = buildLayeredGcodePreview(parsed)
          gcodePreviewRef.current = preview
          setGcodeLayerCount(preview.layerCount)
          setGcodeTopLayer(preview.layerCount - 1)
          setGcodeSingleLayer(false)
          setGcodeMoveEnd(null)
          setGcodeMoveCount(preview.moveCount(preview.layerCount - 1))
          setGcodeStats(parsed.stats)
          attachObject(buildPlateGcodePreviewObject(preview.object, sceneQuery.data?.bed ?? null))
        })
        .catch(handleLoadError)
    } else {
      const sceneData = sceneQuery.data
      if (!sceneData) {
        setViewerState({ loading: false, error: 'No plated 3D scene is available for this 3MF.' })
        return
      }

      void buildThreeMfSceneObject(resourceBase, sceneData, loadAbortController.signal).then(
        (object) => attachObject(object),
        handleLoadError
      )
    }

    let frame = 0
    const animate = () => {
      controls.update()
      syncViewCubeOrientation()
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    animate()

    const onResize = () => {
      renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
        camera.updateProjectionMatrix()
      } else {
        applyPlatedOrthoProjection()
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      if (applyViewPresetRef.current === applyViewPreset) {
        applyViewPresetRef.current = null
      }
      cancelled = true
      loadAbortController.abort()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      renderer.dispose()
      viewCube.dispose()
      if (previewObject) {
        scene.remove(previewObject)
        disposeObject3D(previewObject)
      }
      gcodePreviewRef.current = null
      container.removeChild(renderer.domElement)
      viewCubeContainer.replaceChildren()
    }
  }, [
    file,
    fileId,
    resourceBase,
    fileQuery.error,
    fileQuery.isLoading,
    fileQuery.isSuccess,
    platesQuery.isLoading,
    sceneQuery.data,
    sceneQuery.error,
    sceneQuery.isLoading,
    open,
    previewMode,
    selectedPlate,
    viewerContainer,
    viewCubeContainer
  ])

  // Track the scrubbable move count of the current top layer; changing layers resets the
  // within-layer scrub to "whole layer".
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    setGcodeMoveEnd(null)
    setGcodeMoveCount(gcodePreviewRef.current?.moveCount(gcodeTopLayer) ?? 0)
  }, [gcodeTopLayer, gcodeLayerCount])

  // Apply the layer + move sliders to the built G-code preview (draw-range only; cheap).
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    gcodePreviewRef.current?.setVisibleLayers(gcodeTopLayer, {
      single: gcodeSingleLayer,
      moveEnd: gcodeMoveEnd ?? undefined
    })
  }, [gcodeTopLayer, gcodeSingleLayer, gcodeMoveEnd, gcodeLayerCount])

  // Keyboard scrubbing (Bambu-style): Up/Down step the visible top layer, Left/Right scrub
  // moves within that layer — mirroring the on-screen layer and move sliders. Active only
  // while a layered G-code preview is shown and focus isn't in a form control.
  useEffect(() => {
    if (previewMode !== 'plate-gcode' || gcodeLayerCount === 0) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      switch (event.key) {
        case 'ArrowUp':
          setGcodeTopLayer((layer) => Math.min(layer + 1, gcodeLayerCount - 1))
          break
        case 'ArrowDown':
          setGcodeTopLayer((layer) => Math.max(layer - 1, 0))
          break
        case 'ArrowRight':
          // null === "whole layer" (max); stepping past the last move snaps back to it.
          setGcodeMoveEnd((end) => {
            const next = (end ?? gcodeMoveCount) + 1
            return next >= gcodeMoveCount ? null : next
          })
          break
        case 'ArrowLeft':
          setGcodeMoveEnd((end) => Math.max((end ?? gcodeMoveCount) - 1, 0))
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewMode, gcodeLayerCount, gcodeMoveCount])

  if (!open || !onClose) return null

  const heading = isMeshPreviewMode(previewMode) ? '3D preview' : '3D plate preview'
  const showPlatePicker = !isMeshPreviewMode(previewMode) && plates.length > 0

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog variant="outlined" sx={{ width: { xs: '100%', md: 1120 }, maxWidth: '100%' }}>
        <ModalClose onClick={onClose} sx={{ top: 12, right: 12 }} />
        <DialogTitle>{heading}</DialogTitle>
        <DialogContent>
          {file ? formatLibraryFileName(file.name) : 'Inspect the selected file in 3D without leaving the library.'}
        </DialogContent>
        <ScrollableDialogBody sx={{ pt: 1.5 }}>
          <Stack spacing={1.5} sx={{ minWidth: 0 }}>
            {showPlatePicker && fileId && (
              <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
                <Box sx={{ width: '100%', minWidth: 0 }}>
                  <LibraryPlateCardPicker
                    fileId={fileId}
                    resourceBasePath={resourceBase}
                    thumbnailVersion={file?.uploadedAt ?? null}
                    plates={plates}
                    value={selectedPlate}
                    onChange={setSelectedPlate}
                    label={null}
                    collapsed={plateStripCollapsed}
                    onToggleCollapsed={() => setPlateStripCollapsed(!plateStripCollapsed)}
                  />
                </Box>
              </Sheet>
            )}
            <Sheet
              variant="soft"
              sx={{
                height: { xs: '50dvh', sm: '62dvh' },
                minHeight: { xs: 300, sm: 360 },
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 'md',
                bgcolor: '#0d1322'
              }}
            >
              <Box ref={setViewerContainer} sx={{ position: 'absolute', inset: 0 }} />
              {viewerState.loading && (
                <Stack
                  spacing={1}
                  alignItems="center"
                  justifyContent="center"
                  sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(8, 11, 20, 0.42)', backdropFilter: 'blur(2px)' }}
                >
                  <CircularProgress size="sm" />
                  <Typography level="body-sm" textColor="neutral.200">Loading 3D preview…</Typography>
                </Stack>
              )}
              {viewerState.error && !viewerState.loading && (
                <Alert color="warning" variant="soft" sx={{ position: 'absolute', top: 16, left: 16, right: 16, zIndex: 1 }}>
                  {viewerState.error}
                </Alert>
              )}
              {previewMode === 'plate-gcode' && gcodeLayerCount > 1 && !viewerState.loading && !viewerState.error && (
                <Sheet
                  variant="soft"
                  sx={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    bottom: 12,
                    zIndex: 1,
                    px: 1,
                    py: 1.5,
                    borderRadius: 'md',
                    bgcolor: 'rgba(13, 19, 34, 0.72)',
                    backdropFilter: 'blur(2px)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 1
                  }}
                >
                  <Chip size="sm" variant="soft" color="neutral">{gcodeTopLayer + 1}/{gcodeLayerCount}</Chip>
                  <Slider
                    orientation="vertical"
                    size="sm"
                    min={0}
                    max={gcodeLayerCount - 1}
                    value={gcodeTopLayer}
                    onChange={(_event, value) => setGcodeTopLayer(typeof value === 'number' ? value : value[0] ?? 0)}
                    aria-label="G-code layer"
                    sx={{ flex: 1, minHeight: 120 }}
                  />
                  <Switch
                    size="sm"
                    checked={gcodeSingleLayer}
                    onChange={(event) => setGcodeSingleLayer(event.target.checked)}
                    slotProps={{ input: { 'aria-label': 'Show only the selected layer' } }}
                  />
                  <Typography level="body-xs" textColor="neutral.300" sx={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                    Single layer
                  </Typography>
                </Sheet>
              )}
              {previewMode === 'plate-gcode' && gcodeMoveCount > 1 && !viewerState.loading && !viewerState.error && (
                // Top edge: the bottom-left corner belongs to the view cube and the right
                // edge to the layer panel, so the move scrubber gets the top strip
                // (stopping short of the layer panel's column).
                <Sheet
                  variant="soft"
                  sx={{
                    position: 'absolute',
                    left: 12,
                    right: { xs: 88, sm: 96 },
                    top: 12,
                    zIndex: 1,
                    px: 1.5,
                    py: 0.75,
                    borderRadius: 'md',
                    bgcolor: 'rgba(13, 19, 34, 0.72)',
                    backdropFilter: 'blur(2px)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1
                  }}
                >
                  <Typography level="body-xs" textColor="neutral.300" sx={{ whiteSpace: 'nowrap' }}>
                    Moves
                  </Typography>
                  <Slider
                    size="sm"
                    min={0}
                    max={gcodeMoveCount}
                    value={gcodeMoveEnd ?? gcodeMoveCount}
                    onChange={(_event, value) => setGcodeMoveEnd(typeof value === 'number' ? value : value[0] ?? 0)}
                    aria-label="G-code moves within the top layer"
                    sx={{ flex: 1, minWidth: 0 }}
                  />
                  <Chip size="sm" variant="soft" color="neutral">
                    {gcodeMoveEnd ?? gcodeMoveCount}/{gcodeMoveCount}
                  </Chip>
                </Sheet>
              )}
              {previewMode === 'plate-gcode' && gcodeStats && !viewerState.loading && !viewerState.error && (
                <GcodeStatsPanel
                  stats={gcodeStats}
                  plate={plates.find((plate) => plate.index === selectedPlate) ?? null}
                  layerCount={gcodeLayerCount}
                  open={gcodeStatsOpen}
                  onToggle={() => setGcodeStatsOpen(!gcodeStatsOpen)}
                />
              )}
              <Box
                sx={{
                  position: 'absolute',
                  left: { xs: -18, sm: 0 },
                  bottom: { xs: -18, sm: 0 },
                  zIndex: (theme) => theme.zIndex.tooltip,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start'
                }}
              >
                <ViewCubeControl
                  onSetContainer={setViewCubeContainer}
                  disabled={viewerState.loading || Boolean(viewerState.error)}
                />
              </Box>
            </Sheet>
          </Stack>
        </ScrollableDialogBody>
      </ScrollableModalDialog>
    </Modal>
  )
}

/**
 * BS-style slice stats overlay for the G-code preview: total time, layer count and
 * height, per-feature time breakdown (colour-keyed to the toolpath palette), and
 * filament usage. Feature times are the parser's feedrate estimate NORMALIZED so the
 * total matches the slicer's own prediction (slice_info `prediction`, else the gcode
 * header estimate) — proportions from the moves, authority from the slicer.
 */
function GcodeStatsPanel({
  stats,
  plate,
  layerCount,
  open,
  onToggle
}: {
  stats: GcodeStats
  plate: ThreeMfIndex['plates'][number] | null
  layerCount: number
  open: boolean
  onToggle: () => void
}) {
  const authoritativeTotal = plate?.prediction ?? stats.headerTotalSeconds ?? stats.totalSeconds
  const scale = stats.totalSeconds > 0 && authoritativeTotal > 0 ? authoritativeTotal / stats.totalSeconds : 1
  const rows = stats.featureSeconds
    .map((seconds, role) => ({ role, seconds: seconds * scale, extrusionMm: stats.featureExtrusionMm[role] ?? 0 }))
    .filter((row) => row.seconds >= 0.5)
    .sort((left, right) => right.seconds - left.seconds)
  const travelSeconds = stats.travelSeconds * scale
  const percentOf = (seconds: number) => authoritativeTotal > 0 ? `${Math.max(1, Math.round((seconds / authoritativeTotal) * 100))}%` : ''
  const usedFilaments = (plate?.filaments ?? []).filter((filament) => filament.usedGrams != null && filament.usedGrams > 0)
  if (!open) {
    return (
      <Tooltip title="Print statistics">
        <IconButton
          size="sm"
          variant="soft"
          onClick={onToggle}
          aria-label="Show print statistics"
          sx={{ position: 'absolute', left: 12, top: 72, zIndex: 1, bgcolor: 'rgba(13, 19, 34, 0.72)', backdropFilter: 'blur(2px)' }}
        >
          <QueryStatsRoundedIcon />
        </IconButton>
      </Tooltip>
    )
  }
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute',
        left: 12,
        // Below the Moves scrubber strip (top: 12 + its height), never over it.
        top: 72,
        zIndex: 1,
        px: 1.25,
        py: 1,
        borderRadius: 'md',
        bgcolor: 'rgba(13, 19, 34, 0.78)',
        backdropFilter: 'blur(2px)',
        width: 'min(248px, calc(100% - 110px))',
        maxHeight: 'calc(100% - 140px)',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        onClick={onToggle}
        sx={{ cursor: 'pointer', userSelect: 'none' }}
        aria-label="Collapse print statistics"
      >
        <Typography level="title-sm" textColor="neutral.100">Print statistics</Typography>
        <Tooltip title="Collapse">
          <IconButton size="sm" variant="plain" aria-label="Hide print statistics">
            <ExpandLessRoundedIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography level="body-xs" textColor="neutral.300">Total time</Typography>
        <Typography level="body-xs" fontWeight="lg" textColor="neutral.100">
          {formatSecondsDuration(Math.round(authoritativeTotal))}
        </Typography>
      </Stack>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography level="body-xs" textColor="neutral.300">Layers</Typography>
        <Typography level="body-xs" textColor="neutral.100">{layerCount} · {stats.maxZ.toFixed(1)} mm</Typography>
      </Stack>
      {(plate?.weight != null || stats.filamentMm > 0) && (
        <Stack direction="row" justifyContent="space-between" spacing={1}>
          <Typography level="body-xs" textColor="neutral.300">Filament</Typography>
          <Typography level="body-xs" textColor="neutral.100">
            {plate?.weight != null ? `${plate.weight.toFixed(1)} g` : ''}
            {plate?.weight != null && stats.filamentMm > 0 ? ' · ' : ''}
            {stats.filamentMm > 0 ? `${(stats.filamentMm / 1000).toFixed(2)} m` : ''}
          </Typography>
        </Stack>
      )}
      {usedFilaments.length > 1 && usedFilaments.map((filament) => (
        <Stack key={filament.id} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: filament.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
            <Typography level="body-xs" textColor="neutral.300" noWrap>
              {filament.filamentName ?? filament.filamentType ?? `Filament ${filament.id}`}
            </Typography>
          </Stack>
          <Typography level="body-xs" textColor="neutral.100">{filament.usedGrams!.toFixed(1)} g</Typography>
        </Stack>
      ))}
      {rows.length > 0 && (
        <>
          <Divider sx={{ my: 0.25 }} />
          {rows.map((row) => (
            <Stack key={row.role} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: `#${(GCODE_FEATURE_COLORS[row.role] ?? 0x888888).toString(16).padStart(6, '0')}` }} />
                <Typography level="body-xs" textColor="neutral.300" noWrap>{GCODE_FEATURE_NAMES[row.role] ?? 'Other'}</Typography>
              </Stack>
              <Typography level="body-xs" textColor="neutral.100" sx={{ whiteSpace: 'nowrap' }}>
                {formatSecondsDuration(Math.max(1, Math.round(row.seconds)))} · {percentOf(row.seconds)}
              </Typography>
            </Stack>
          ))}
          {travelSeconds >= 0.5 && (
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: 'neutral.600' }} />
                <Typography level="body-xs" textColor="neutral.300">Travel</Typography>
              </Stack>
              <Typography level="body-xs" textColor="neutral.100" sx={{ whiteSpace: 'nowrap' }}>
                {formatSecondsDuration(Math.max(1, Math.round(travelSeconds)))} · {percentOf(travelSeconds)}
              </Typography>
            </Stack>
          )}
        </>
      )}
    </Sheet>
  )
}

function ViewCubeControl({
  onSetContainer,
  disabled
}: {
  onSetContainer: (node: HTMLDivElement | null) => void
  disabled: boolean
}) {
  return (
    <Box
      sx={{
        position: 'relative',
        width: VIEW_CUBE_SIZE,
        height: VIEW_CUBE_SIZE,
        pointerEvents: disabled ? 'none' : 'auto'
      }}
    >
      <Box
        ref={onSetContainer}
        aria-label="Preview orientation cube"
        sx={{
          width: VIEW_CUBE_SIZE,
          height: VIEW_CUBE_SIZE,
          '& canvas': {
            display: 'block'
          }
        }}
      />
    </Box>
  )
}

type PreviewMode = 'stl' | 'step' | '3mf' | 'plate-gcode' | null

function resolvePreviewMode(file: LibraryFile | null): PreviewMode {
  if (!file) return null
  if (file.kind === 'stl') return 'stl'
  if (file.kind === 'step') return 'step'
  if (file.kind === '3mf') return '3mf'
  if (file.kind === 'gcode') return 'plate-gcode'
  return null
}

/** STL and STEP both render as a single un-plated mesh (STEP is tessellated to STL server-side). */
function isMeshPreviewMode(mode: PreviewMode): boolean {
  return mode === 'stl' || mode === 'step'
}

async function buildThreeMfSceneObject(
  resourceBase: string,
  scene: LibraryThreeMfScene,
  signal: AbortSignal
): Promise<THREE.Object3D> {
  const plateGroup = new THREE.Group()

  const bedWidth = Math.max(scene.bed.maxX - scene.bed.minX, 1)
  const bedDepth = Math.max(scene.bed.maxY - scene.bed.minY, 1)
  const bedCenterX = (scene.bed.minX + scene.bed.maxX) / 2
  const bedCenterY = (scene.bed.minY + scene.bed.maxY) / 2
  plateGroup.add(createPreviewPlateSurface({
    width: bedWidth,
    depth: bedDepth,
    centerX: bedCenterX,
    centerY: bedCenterY,
    excludeAreas: scene.bed.excludeAreas
  }))

  const entryPaths = [...new Set(scene.parts.map((part) => part.entryPath))]
  const modelMaps = new Map<string, Map<number, THREE.BufferGeometry>>()
  await Promise.all(entryPaths.map(async (entryPath) => {
    const response = await fetch(buildApiUrl(`${resourceBase}/scene-entry?path=${encodeURIComponent(entryPath)}`), { signal })
    if (!response.ok) {
      throw new Error(`Unable to load scene model ${entryPath}.`)
    }
    const xmlText = await response.text()
    modelMaps.set(entryPath, parseThreeMfModelEntry(xmlText))
  }))

  let placedPartCount = 0
  for (const part of scene.parts) {
    const modelMap = modelMaps.get(part.entryPath)
    const geometry = modelMap?.get(part.objectId)
    if (!geometry) continue
    const partTransform = createThreeMfMatrix(part.transform)
    plateGroup.add(createThreeMfPartObject(geometry, {
      // Parts without an extruder render in the DEFAULT filament, like Bambu Studio.
      color: part.color ?? scene.projectFilaments?.[0]?.color ?? null,
      transform: partTransform,
      colorPaintFilaments: scene.projectFilaments ?? null
    }))
    placedPartCount += 1
  }

  if (placedPartCount === 0) {
    disposeObject3D(plateGroup)
    throw new Error('This plate does not include previewable mesh geometry.')
  }

  return plateGroup
}

function buildPlateGcodePreviewObject(object: THREE.Object3D, bed: LibraryThreeMfScene['bed'] | null): THREE.Object3D {
  // The layered parser already emits raw G-code coordinates (printer Z-up), matching the
  // Z-up plated scene — so, unlike three's Y-up GCodeLoader output, no rotation is needed.
  object.updateMatrixWorld(true)

  const bounds = new THREE.Box3().setFromObject(object)
  if (bounds.isEmpty()) {
    disposeObject3D(object)
    throw new Error('This plate does not include previewable G-code geometry.')
  }

  const plateGroup = new THREE.Group()
  if (bed) {
    // Real printer plate (absolute bed coordinates): the G-code is authored in bed space, so
    // the surface spans the machine's true footprint and exclude zones rather than a generic
    // square centred on the toolpaths (which read as a small A1-style bed for an H2D plate).
    plateGroup.add(createPreviewPlateSurface({
      width: Math.max(bed.maxX - bed.minX, 1),
      depth: Math.max(bed.maxY - bed.minY, 1),
      centerX: (bed.minX + bed.maxX) / 2,
      centerY: (bed.minY + bed.maxY) / 2,
      excludeAreas: bed.excludeAreas
    }))
  } else {
    // Fallback when the scene/bed is unavailable: a generic square grid under the toolpaths.
    const center = bounds.getCenter(new THREE.Vector3())
    plateGroup.add(createPreviewPlateSurface({
      width: PLATED_PREVIEW_GRID_SIZE,
      depth: PLATED_PREVIEW_GRID_SIZE,
      centerX: center.x,
      centerY: center.y
    }))
  }
  plateGroup.add(object)
  return plateGroup
}

