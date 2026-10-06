/**
 * Owns the hosted Text tool's mesh highlight. It changes existing materials in place so hover and
 * drag never detach the selected mesh, and restores their emissive colour when the session ends.
 * Standalone Text keeps the normal object styling and is deliberately never highlighted.
 */
import { useEffect } from 'react'
import * as THREE from 'three'
import { rotorOf, TEXT_HIGHLIGHT_COLORS, type GizmoMode, type TextInteraction } from './editorGeometry'

interface TextHighlightOptions {
  mode: GizmoMode
  partKey: string | null
  selectedKey: string | null
  hostKeyRef: { current: string | null }
  groupByKeyRef: { current: Map<string, THREE.Group> }
  meshRef: { current: THREE.Mesh | null }
  interaction: TextInteraction
  meshVersion: number
}

/** Tint the mounted hosted Text mesh while it is available to grab. */
export function useEditorTextHighlight(options: TextHighlightOptions): void {
  useEffect(() => {
    // Capture the map once: cleanup must restore the materials that existed when this ran.
    const groups = options.groupByKeyRef.current
    const hostKey = options.hostKeyRef.current ?? options.selectedKey
    const group = hostKey ? groups.get(hostKey) : null
    const active = options.mode === 'text' && options.partKey != null
    const found: THREE.Mesh[] = []
    if (group) {
      rotorOf(group).traverse((node) => {
        if (node.userData.addedPartKey === options.partKey) found.push(node as THREE.Mesh)
      })
    }
    const meshes = active ? found : []
    options.meshRef.current = meshes[0] ?? null
    if (meshes.length === 0) return

    // During a drag, show the colour the text will print instead of a hover tint.
    const tint = options.interaction === 'drag'
      ? 0x000000
      : TEXT_HIGHLIGHT_COLORS[options.interaction]
    const materials = meshes.map((mesh) => mesh.material as THREE.MeshStandardMaterial)
    for (const material of materials) {
      material.emissive.setHex(tint)
      material.needsUpdate = true
    }
    return () => {
      for (const material of materials) {
        material.emissive.setHex(0x000000)
        material.needsUpdate = true
      }
    }
  }, [options.mode, options.partKey, options.selectedKey, options.interaction,
    options.meshVersion, options.hostKeyRef, options.groupByKeyRef, options.meshRef])
}
