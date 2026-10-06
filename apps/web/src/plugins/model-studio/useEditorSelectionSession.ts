/**
 * Owns object and part selection state shared by the editor viewport and sidebar.
 * The primary object key and gizmo part stay with the parent scene coordinator;
 * this hook keeps their companion selection modes exclusive and prunes stale members.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { addedPartHostId, type EditorState } from './lib/editorModel'
import { ownerPartMembers } from './lib/editorPartSelectionAction'
import {
  prunePartSelection,
  selectionHasMember,
  type PartRef,
  type PartSelection
} from './lib/selectionModel'

interface EditorSelectionSessionOptions {
  activePlateIndex: number
  state: EditorState | null
  stateRef: MutableRefObject<EditorState | null>
  selectedKey: string | null
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
}

/**
 * Return the current multi-object or multi-part selection and stable entry refs.
 * A plain object selection clears part mode; Ctrl/Cmd toggles the object set.
 * References to removed or inactive objects and parts are pruned after scene edits.
 */
export function useEditorSelectionSession(options: EditorSelectionSessionOptions) {
  const {
    activePlateIndex,
    state,
    stateRef,
    selectedKey,
    setSelectedKey,
    setGizmoPart
  } = options
  const selectedKeyRef = useRef<string | null>(null)
  selectedKeyRef.current = selectedKey

  const [extraSelectedKeys, setExtraSelectedKeys] = useState<ReadonlyArray<string>>([])
  const extraSelectedKeysRef = useRef(extraSelectedKeys)
  extraSelectedKeysRef.current = extraSelectedKeys
  const [partSelection, setPartSelection] = useState<PartSelection | null>(null)
  const partSelectionRef = useRef(partSelection)
  partSelectionRef.current = partSelection
  const objectAnchorKeyRef = useRef<string | null>(null)
  const partAnchorRef = useRef<PartRef | null>(null)

  const selectExclusive = useCallback((key: string | null) => {
    setSelectedKey(key)
    setExtraSelectedKeys((current) => current.length > 0 ? [] : current)
    setPartSelection((current) => current ? null : current)
    setGizmoPart((current) => current ? null : current)
    if (key) objectAnchorKeyRef.current = key
  }, [setSelectedKey, setGizmoPart])
  const selectExclusiveRef = useRef(selectExclusive)
  selectExclusiveRef.current = selectExclusive

  const toggleAdditiveSelection = useCallback((key: string) => {
    const primary = selectedKeyRef.current
    const extras = extraSelectedKeysRef.current
    setPartSelection((current) => current ? null : current)
    setGizmoPart((current) => current ? null : current)
    objectAnchorKeyRef.current = key
    if (primary === key) {
      const [next, ...rest] = extras
      setSelectedKey(next ?? null)
      setExtraSelectedKeys(rest)
    } else if (extras.includes(key)) {
      setExtraSelectedKeys(extras.filter((entry) => entry !== key))
    } else if (primary) {
      setExtraSelectedKeys([...extras, key])
    } else {
      setSelectedKey(key)
    }
  }, [setSelectedKey, setGizmoPart])
  const toggleAdditiveSelectionRef = useRef(toggleAdditiveSelection)
  toggleAdditiveSelectionRef.current = toggleAdditiveSelection

  const allSelectedKeys = useCallback((): string[] => {
    const primary = selectedKeyRef.current
    return primary ? [primary, ...extraSelectedKeysRef.current] : []
  }, [])
  const allSelectedKeysRef = useRef(allSelectedKeys)
  allSelectedKeysRef.current = allSelectedKeys

  // Extras only name instances on the active plate, and must never repeat the primary key.
  useEffect(() => {
    setExtraSelectedKeys((current) => {
      if (current.length === 0) return current
      const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
      const valid = new Set(plate?.instances.map((entry) => entry.key) ?? [])
      const next = current.filter((key) => valid.has(key) && key !== selectedKey)
      return next.length === current.length ? current : next
    })
  }, [activePlateIndex, state, selectedKey, stateRef])

  // Part identity is geometry-level, so search every plate and both baked and added volumes.
  useEffect(() => {
    setPartSelection((current) => {
      if (!current) return current
      const owner = state?.plates.flatMap((plate) => plate.instances).find((instance) => {
        const ownerId = instance.source.kind === 'object'
          ? instance.objectId
          : instance.source.replacedObjectId
        return ownerId === current.objectId
      })
      return prunePartSelection(current, owner ? ownerPartMembers(owner, state ?? null) : null)
    })
    setGizmoPart((current) => {
      if (!current) return current
      const stillExists = state?.plates.some((plate) => plate.instances.some((instance) =>
        addedPartHostId(instance) === current.objectId
        && selectionHasMember(ownerPartMembers(instance, state ?? null), current.member)))
      return stillExists ? current : null
    })
  }, [state, setGizmoPart])

  return {
    selectedKeyRef,
    extraSelectedKeys,
    setExtraSelectedKeys,
    extraSelectedKeysRef,
    partSelection,
    setPartSelection,
    partSelectionRef,
    objectAnchorKeyRef,
    partAnchorRef,
    selectExclusive,
    selectExclusiveRef,
    toggleAdditiveSelection,
    toggleAdditiveSelectionRef,
    allSelectedKeys,
    allSelectedKeysRef
  }
}
