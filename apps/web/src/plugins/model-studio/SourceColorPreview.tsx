/** Owns the small, rotatable Original/Multi-Color comparison in the source-colour dialog. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Tab, TabList, Tabs, Typography } from '@mui/joy'
import type { ImportedMesh, QuantizedSourceColors } from '@printstream/shared/three-mf'
import * as THREE from 'three'
import { OrbitControls } from 'three-stdlib'
import {
  buildQuantizedPreviewColors,
  buildSourceColorPreviewGeometry
} from './lib/sourceColorPreview'
import { acquireOverlayViewerHold } from './lib/overlayViewerHold'
import { createWebglRenderer } from './lib/webglRenderer'

interface SourceColorPreviewProps {
  mesh: Pick<ImportedMesh, 'positions' | 'indices'>
  sourceColors: Float32Array
  quantized: QuantizedSourceColors
}

type PreviewMode = 'original' | 'quantized'

/** Render source pixels or their current filament-colour reduction without changing the model. */
export function SourceColorPreview({ mesh, sourceColors, quantized }: SourceColorPreviewProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<PreviewMode>('quantized')
  const [unavailable, setUnavailable] = useState(false)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const geometryRef = useRef<THREE.BufferGeometry | null>(null)
  const preview = useMemo(
    () => buildSourceColorPreviewGeometry(mesh, sourceColors),
    [mesh, sourceColors]
  )

  useEffect(() => {
    if (!container) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#101827')
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100000)
    camera.up.set(0, 0, 1)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(preview.positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(preview.originalColors, 3))
    geometry.computeBoundingSphere()
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    scene.add(new THREE.Mesh(geometry, material))

    let renderer: THREE.WebGLRenderer
    try {
      renderer = createWebglRenderer({ antialias: true })
    } catch {
      setUnavailable(true)
      geometry.dispose()
      material.dispose()
      return
    }
    setUnavailable(false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    container.appendChild(renderer.domElement)

    const onContextLost = (event: Event) => {
      event.preventDefault()
      setUnavailable(true)
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    // This dialog covers the editor, so its lightweight viewer owns the GPU while it is open.
    const releaseOverlayHold = acquireOverlayViewerHold()

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.enablePan = true
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    const sphere = geometry.boundingSphere
    if (sphere) {
      const radius = Math.max(sphere.radius, 0.01)
      controls.target.copy(sphere.center)
      camera.position.copy(sphere.center).add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(radius * 2.8))
      camera.near = Math.max(radius / 1000, 0.001)
      camera.far = Math.max(radius * 100, 100)
      camera.updateProjectionMatrix()
      // OrbitControls captured the camera's old pose when it was constructed. Synchronize after
      // framing so the first render looks at the model; otherwise it stays blank until a drag
      // causes the controls to update the camera orientation.
      controls.update()
    }

    const render = () => renderer.render(scene, camera)
    const resize = () => {
      const width = Math.max(container.clientWidth, 1)
      const height = Math.max(container.clientHeight, 1)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      // Update the canvas CSS size as well as its drawing buffer. Leaving updateStyle false makes
      // the high-DPI buffer dimensions become the canvas's layout dimensions, so a 1.5x display
      // grows the preview 50% beyond the dialog and clips the model off-screen.
      renderer.setSize(width, height)
      render()
    }
    controls.addEventListener('change', render)
    // Match the full preview viewer: browser resizes are the dependable signal for responsive
    // dialog changes, while ResizeObserver covers container-only changes.
    window.addEventListener('resize', resize)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(container)

    rendererRef.current = renderer
    sceneRef.current = scene
    cameraRef.current = camera
    geometryRef.current = geometry
    resize()

    return () => {
      releaseOverlayHold()
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      controls.removeEventListener('change', render)
      controls.dispose()
      geometry.dispose()
      material.dispose()
      // Remove this before the deliberate loss below so teardown is not reported as a failure.
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      rendererRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      geometryRef.current = null
    }
  }, [container, preview])

  useEffect(() => {
    const geometry = geometryRef.current
    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    if (!geometry || !renderer || !scene || !camera) return

    const colors = mode === 'original'
      ? preview.originalColors
      : buildQuantizedPreviewColors(mesh.indices.length, quantized)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    renderer.render(scene, camera)
  }, [mesh.indices.length, mode, preview.originalColors, quantized])

  return (
    <Box>
      <Tabs value={mode} onChange={(_event, value) => setMode(value as PreviewMode)}>
        <TabList size="sm">
          <Tab value="original">Original</Tab>
          <Tab value="quantized">Multi-Color</Tab>
        </TabList>
      </Tabs>
      <Box
        ref={setContainer}
        role="img"
        aria-label={`${mode === 'original' ? 'Original source colour' : 'Reduced multi-color'} model preview. Drag to rotate.`}
        sx={{
          position: 'relative',
          mt: 1,
          height: { xs: 220, sm: 300 },
          overflow: 'hidden',
          borderRadius: 'sm',
          border: '1px solid',
          borderColor: 'divider',
          touchAction: 'none',
          '& canvas': { display: 'block' }
        }}
      >
        {unavailable ? (
          <Typography
            level="body-sm"
            textColor="text.tertiary"
            sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 2 }}
          >
            3D comparison preview is unavailable. Colour mapping still works below.
          </Typography>
        ) : null}
      </Box>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
        Drag to rotate. Scroll or pinch to zoom.
      </Typography>
    </Box>
  )
}
