/**
 * Applies transform-only plate edits to mounted instance groups without reloading geometry.
 * A group still rendered from an exact matrix cannot accept decomposed TRS safely, so the caller
 * must rebuild the plate if any live group is in that mode.
 */
import * as THREE from 'three'
import { rotorOf } from '../editorGeometry'
import type { EditorInstance, EditorState } from './editorModel'

/** Return false when a full rebuild is required; otherwise mutate all matching live groups. */
export function syncEditorTransformScene(state: EditorState, groups: ReadonlyMap<string, THREE.Group>): boolean {
  const byKey = new Map<string, EditorInstance>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) byKey.set(instance.key, instance)
  }

  // Check every group first so a fallback never leaves a half-updated scene visible.
  for (const [key, group] of groups) {
    if (byKey.has(key) && !group.matrixAutoUpdate) return false
  }

  for (const [key, group] of groups) {
    const instance = byKey.get(key)
    if (!instance) continue
    group.position.copy(instance.position)
    group.scale.copy(instance.scale)
    rotorOf(group).rotation.copy(instance.rotation)
  }
  return true
}
